import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  useNodesState,
  useEdgesState,
  type Node,
  type NodeTypes,
  BackgroundVariant,
  type OnConnect,
  type NodeProps,
  addEdge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./styles/canvas.css";

import { ThesisNote } from "./nodes/ThesisNote";
import { PdfPreview } from "./nodes/PdfPreview";
import { HtmlFrame } from "./nodes/HtmlFrame";
import { EmbedNode } from "./nodes/EmbedNode";
import { CanvasToolbar, type CanvasTool } from "./toolbar/CanvasToolbar";
import { NodeWrapper } from "./NodeWrapper";
import { CanvasContext } from "./CanvasContext";
import { WireEdge } from "./edges/WireEdge";
import { ChannelPicker } from "./toolbar/ChannelPicker";

// Label extractors per node type
function getNodeLabel(type: string, data: Record<string, unknown>): string {
  switch (type) {
    case "note":
      return (data.title as string) || "Note";
    case "pdf":
      return (data.title as string) || "PDF";
    case "frame":
      return (data.title as string) || "HTML Frame";
    case "embed":
      return (data.title as string) || "Embed";
    default:
      return (data.title as string) || type;
  }
}

// Stable reference: callbacks are passed via module-level refs
// so the wrapped node types don't change identity and trigger unmount/remount
let deleteNodeRef: ((id: string) => void) | null = null;
let shareNodeRef: ((id: string) => void) | null = null;
let toggleBindingRef: ((id: string) => void) | null = null;
let openInBrowserRef: ((id: string) => void) | null = null;
let openInCompanionRef: ((id: string) => void) | null = null;
let openInEditorRef: ((id: string) => void) | null = null;

function createWrappedNode(
  InnerComponent: React.ComponentType<NodeProps>,
  typeName: string,
  isShareable = false,
  isBrowsable = false,
  isCompanionable = false,
  isEditable = false
): React.ComponentType<NodeProps> {
  const Wrapped = (props: NodeProps) => {
    const data = props.data as Record<string, unknown>;
    const label = getNodeLabel(typeName, data);
    const binding = data._binding as
      | { enabled: boolean; lastRun?: string; lastError?: string; bindingType?: string; hasScript?: boolean; hasPrompt?: boolean }
      | undefined;
    const hasFilePath = isEditable && typeof data._filePath === "string";
    return (
      <NodeWrapper
        id={props.id}
        label={label}
        selected={!!props.selected}
        onDelete={(id) => deleteNodeRef?.(id)}
        onShare={isShareable ? (id) => shareNodeRef?.(id) : undefined}
        onToggleBinding={binding ? (id) => toggleBindingRef?.(id) : undefined}
        onOpenInBrowser={isBrowsable ? (id) => openInBrowserRef?.(id) : undefined}
        onOpenInCompanion={isCompanionable ? (id) => openInCompanionRef?.(id) : undefined}
        onOpenInEditor={hasFilePath ? (id) => openInEditorRef?.(id) : undefined}
        binding={binding}
        c2={!!data._c2}
      >
        <InnerComponent {...props} />
      </NodeWrapper>
    );
  };
  Wrapped.displayName = `Wrapped${typeName}`;
  return Wrapped;
}

// Create wrapped node types once (stable references)
const nodeTypes: NodeTypes = {
  note: createWrappedNode(ThesisNote, "note", false, false, false, true),
  pdf: createWrappedNode(PdfPreview, "pdf"),
  frame: createWrappedNode(HtmlFrame, "frame", true, true, true),
  embed: createWrappedNode(EmbedNode, "embed", false, true, true),
};

// Custom edge types
const edgeTypes = { wire: WireEdge };

// Declare VS Code API type
declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

// Reuse the early-init vscode API if set by the HTML template (avoids double acquireVsCodeApi)
const vscode =
  (window as unknown as Record<string, unknown>).__vscode as ReturnType<typeof acquireVsCodeApi> ??
  acquireVsCodeApi();

interface RefreshBindingState {
  elementId: string;
  scriptPath: string;
  intervalMs: number;
  enabled: boolean;
  lastRun?: string;
  lastError?: string;
  createdAt: string;
}

export default function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [refreshBindings, setRefreshBindings] = useState<RefreshBindingState[]>([]);
  const [tool, setTool] = useState<CanvasTool>("pointer");
  const saveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Gate auto-save until initial state is loaded from disk (prevents overwriting data with empty state)
  const stateLoadedRef = useRef(false);
  // Track peak element count — prevents auto-saving empty canvas when elements existed
  const peakElementCountRef = useRef(0);

  // Canvas identity (set by canvas.init message from extension)
  const canvasIdRef = useRef<string | null>(null);
  const canvasNameRef = useRef<string>("Research Board");
  const [displayName, setDisplayName] = useState("Research Board");
  const [fileUrlBase, setFileUrlBase] = useState("");

  // C2 mode state
  const [c2Enabled, setC2Enabled] = useState(false);
  const [c2WireCount, setC2WireCount] = useState(0);
  const isProjectCanvasRef = useRef(false);

  // Pending wire connection (waiting for channel picker)
  const [pendingConnection, setPendingConnection] = useState<{
    source: string;
    target: string;
    position: { x: number; y: number };
  } | null>(null);

  // Refs for message handler callbacks — avoids re-registering the handler on every render
  const debouncedSaveRef = useRef<() => void>(() => {});
  const serializeStateRef = useRef<() => ReturnType<typeof serializeState>>(() => ({ name: "", elements: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }) as ReturnType<typeof serializeState>);
  const readySentRef = useRef(false);

  /** Serialize current canvas state into the CanvasState shape. */
  const serializeState = useCallback(() => ({
    name: canvasNameRef.current,
    elements: nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: n.position,
      size: {
        width: (n.style as Record<string, number>)?.width || (n as Node & { width?: number }).width || 272,
        height: (n.style as Record<string, number>)?.height || (n as Node & { height?: number }).height || 200,
      },
      data: n.data,
      connections: [],
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      ...(e.type === "wire" ? { type: "wire", data: e.data || {} } : {}),
    })),
    viewport: { x: 0, y: 0, zoom: 1 },
    ...(refreshBindings.length > 0 ? { refreshBindings } : {}),
  }), [nodes, edges, refreshBindings]);

  const debouncedSave = useCallback(() => {
    // Don't save until initial state has been loaded from disk
    if (!stateLoadedRef.current) return;
    if (saveTimeout.current) {
      clearTimeout(saveTimeout.current);
    }
    saveTimeout.current = setTimeout(() => {
      const state = serializeState();
      // Guard: if canvas previously had elements but now has 0, skip save.
      // This prevents accidental wipes from state deserialization failures,
      // restore race conditions, or unintended select-all + delete.
      if (state.elements.length === 0 && peakElementCountRef.current > 0) {
        console.warn("[jetro] Refusing to save empty canvas (had", peakElementCountRef.current, "elements). Use explicit delete instead.");
        return;
      }
      // Track peak for future guard checks
      if (state.elements.length > peakElementCountRef.current) {
        peakElementCountRef.current = state.elements.length;
      }
      vscode.postMessage({
        type: "canvas.stateUpdate",
        data: state,
      });
    }, 500);
  }, [serializeState]);

  // Keep refs in sync with latest callbacks
  debouncedSaveRef.current = debouncedSave;
  serializeStateRef.current = serializeState;

  // Save on changes
  useEffect(() => {
    debouncedSave();
  }, [nodes, edges, debouncedSave]);

  const onConnect: OnConnect = useCallback(
    (params) => {
      if (c2Enabled && params.source && params.target) {
        // In C2 mode, show channel picker instead of creating a plain edge
        setPendingConnection({
          source: params.source,
          target: params.target,
          position: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
        });
        return;
      }
      setEdges((eds) => addEdge({ ...params, id: `e-${Date.now()}` }, eds));
    },
    [setEdges, c2Enabled]
  );

  // Handle channel picker selection — creates a wire edge
  const handleChannelSelect = useCallback(
    (channel: string | null, bidirectional: boolean) => {
      if (!pendingConnection || !channel) {
        setPendingConnection(null);
        return;
      }
      const wireId = `wire_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      // Add the wire edge to ReactFlow
      setEdges((eds) =>
        addEdge(
          {
            id: wireId,
            source: pendingConnection.source,
            target: pendingConnection.target,
            type: "wire",
            data: { channel, bidirectional, label: channel },
          },
          eds
        )
      );
      // Notify extension host to persist the wire in C2 state
      vscode.postMessage({
        type: "canvas.addWire",
        data: {
          id: wireId,
          sourceId: pendingConnection.source,
          targetId: pendingConnection.target,
          channel,
          bidirectional,
        },
      });
      setPendingConnection(null);
    },
    [pendingConnection, setEdges]
  );

  // Listen for messages from extension — runs ONCE on mount (uses refs for mutable callbacks)
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      switch (msg.type) {
        case "canvas.init": {
          const { canvasId, name, isProjectCanvas } = msg.data;
          console.log("[JET-init] canvasId:", canvasId, "name:", name, "isProject:", isProjectCanvas);
          canvasIdRef.current = canvasId;
          canvasNameRef.current = name || "Research Board";
          setDisplayName(canvasNameRef.current);
          isProjectCanvasRef.current = !!isProjectCanvas;
          // Persist canvas ID for serializer (auto-restore on restart)
          vscode.setState({ canvasId });
          break;
        }
        case "canvas.setState": {
          const state = msg.data;
          console.log("[JET-setState] received, elements:", state.elements?.length, "bindings:", state.refreshBindings?.length, "payloadSize:", JSON.stringify(msg).length);
          try {
          if (state.elements) {
            const incomingNodes: Node[] = state.elements.map(
              (el: {
                id: string;
                type: string;
                position: { x: number; y: number };
                size: { width: number; height?: number };
                data: Record<string, unknown>;
              }) => ({
                id: el.id,
                type: el.type.startsWith("custom:") ? "custom" : el.type,
                position: el.position,
                data: el.type.startsWith("custom:")
                  ? { ...el.data, defSlug: el.type.replace("custom:", "") }
                  : el.data,
                style: {
                  width: el.size.width,
                  ...(el.size.height && el.size.height !== 200 ? { height: el.size.height } : {}),
                },
              })
            );
            // Merge: keep any nodes added via canvas.addElement before setState arrived
            // (prevents race where render queue fires before disk state loads)
            setNodes((existingNodes) => {
              const incomingIds = new Set(incomingNodes.map((n) => n.id));
              const extraNodes = existingNodes.filter((n) => !incomingIds.has(n.id));
              return [...incomingNodes, ...extraNodes];
            });
          }
          if (state.edges) {
            setEdges(
              state.edges.map(
                (e: { id: string; source: string; target: string; type?: string; data?: Record<string, unknown> }) => ({
                  id: e.id,
                  source: e.source,
                  target: e.target,
                  ...(e.type === "wire" ? {
                    type: "wire",
                    data: e.data || {},
                  } : {
                    style: { stroke: "#404040", strokeDasharray: "5 5" },
                  }),
                })
              )
            );
          }
          // C2 mode state
          if (state.c2) {
            setC2Enabled(!!state.c2.enabled);
            setC2WireCount(state.c2.wires?.length ?? 0);
          }
          if (state.refreshBindings) {
            setRefreshBindings(state.refreshBindings);
          }
          // Set peak element count from disk state (prevents empty-save guard from being bypassed)
          if (state.elements && state.elements.length > peakElementCountRef.current) {
            peakElementCountRef.current = state.elements.length;
          }
          // Mark state as loaded — enables auto-save (prevents empty-state overwrite)
          stateLoadedRef.current = true;
          } catch (err) {
            console.error("[JET-setState] CRASH during state processing:", err);
          }
          break;
        }
        case "canvas.addElement": {
          // Allow saving when agent adds elements (even if setState hasn't been received yet)
          stateLoadedRef.current = true;
          const el = msg.data;
          const newNodeData = el.type.startsWith("custom:")
            ? { ...el.data, defSlug: el.type.replace("custom:", "") }
            : el.data;
          setNodes((nds) => {
            // Dedup: if a node with the same ID exists, update data in place
            // (preserves position and size so frames don't jump around on re-render)
            const existingIdx = nds.findIndex((n) => n.id === el.id);
            if (existingIdx >= 0) {
              return nds.map((n) =>
                n.id === el.id
                  ? { ...n, data: { ...n.data, ...newNodeData } }
                  : n
              );
            }
            const newNode: Node = {
              id: el.id,
              type: el.type.startsWith("custom:") ? "custom" : el.type,
              position: el.position,
              data: newNodeData,
              style: {
                width: el.size?.width || 272,
                height: el.size?.height || (el.type === "frame" || el.type === "chart" ? 400 : undefined),
              },
            };
            return [...nds, newNode];
          });
          // Force compositor repaint for new frame iframes.
          // Full webview reload after delay — guaranteed fix for Electron compositor bug.
          if (el.type === "frame" || el.type === "chart") {
            setTimeout(() => {
              vscode.postMessage({ type: "canvas.reloadWebview" });
            }, 1500);
          }
          break;
        }
        case "canvas.updateElement": {
          const { id, data } = msg.data;
          setNodes((nds) =>
            nds.map((n) =>
              n.id === id ? { ...n, data: { ...n.data, ...data } } : n
            )
          );
          break;
        }
        case "canvas.fileChanged": {
          // A frame HTML file was modified on disk — update any elements
          // whose _sourceFile matches the changed path.
          const { filePath, html } = msg.data;
          setNodes((nds) =>
            nds.map((n) => {
              const d = n.data as Record<string, unknown>;
              if (d._sourceFile === filePath) {
                return { ...n, data: { ...d, html } };
              }
              return n;
            })
          );
          break;
        }
        case "canvas.refreshElement": {
          const { id: refreshId, payload } = msg.data;
          // Push refresh data into the frame's iframe via postMessage.
          // All frame HTML templates listen for window "message" events with
          // { type: "jet:refresh", payload: ... }, so postMessage is the universal path.
          // Also dispatch a CustomEvent as a secondary channel for frames that use it.
          // DOM dispatch happens outside setNodes() to avoid React batching issues.
          const iframe = document.querySelector(
            `iframe[data-element-id="${refreshId}"]`
          ) as HTMLIFrameElement | null;
          if (iframe?.contentWindow) {
            // Primary: postMessage (works for both srcdoc and blob: iframes)
            iframe.contentWindow.postMessage(
              { type: "jet:refresh", payload },
              "*"
            );
            // Secondary: CustomEvent for frames that listen via addEventListener("jet:refresh")
            try {
              iframe.contentWindow.dispatchEvent(
                new CustomEvent("jet:refresh", { detail: payload })
              );
            } catch { /* cross-origin — postMessage already sent above */ }
          } else {
            // Not a frame element or iframe not mounted — merge into node data
            setNodes((nds) =>
              nds.map((n) =>
                n.id === refreshId ? { ...n, data: { ...n.data, ...payload } } : n
              )
            );
          }
          break;
        }
        case "canvas.removeElement": {
          const removeId = msg.data.id;
          setNodes((nds) => nds.filter((n) => n.id !== removeId));
          setEdges((eds) =>
            eds.filter((e) => e.source !== removeId && e.target !== removeId)
          );
          break;
        }
        case "canvas.moveElement": {
          const { id: moveId, position: movePos } = msg.data;
          setNodes((nds) =>
            nds.map((n) =>
              n.id === moveId ? { ...n, position: movePos } : n
            )
          );
          break;
        }
        case "canvas.resizeElement": {
          const { id: resizeId, size: newSize } = msg.data;
          setNodes((nds) =>
            nds.map((n) => {
              if (n.id !== resizeId) return n;
              const s = { ...(n.style as Record<string, unknown>) };
              if (newSize.width) s.width = newSize.width;
              if (newSize.height) s.height = newSize.height;
              return { ...n, style: s };
            })
          );
          break;
        }
        case "canvas.arrangeElements": {
          const { operations } = msg.data;
          setNodes((nds) => {
            const opMap = new Map<string, { position?: { x: number; y: number }; size?: { width?: number; height?: number } }>();
            for (const op of operations) {
              opMap.set(op.elementId, op);
            }
            return nds.map((n) => {
              const op = opMap.get(n.id);
              if (!op) return n;
              let updated = { ...n };
              if (op.position) {
                updated.position = op.position;
              }
              if (op.size) {
                const s = { ...(updated.style as Record<string, unknown>) };
                if (op.size.width) s.width = op.size.width;
                if (op.size.height) s.height = op.size.height;
                updated.style = s;
              }
              return updated;
            });
          });
          break;
        }
        case "canvas.addBinding": {
          const binding = msg.data as RefreshBindingState;
          setRefreshBindings((prev) => [
            ...prev.filter((b) => b.elementId !== binding.elementId),
            binding,
          ]);
          break;
        }
        case "canvas.removeBinding": {
          const { elementId: unbindId } = msg.data as { elementId: string };
          setRefreshBindings((prev) =>
            prev.filter((b) => b.elementId !== unbindId)
          );
          break;
        }
        case "canvas.updateBinding": {
          const { elementId: patchId, patch } = msg.data as {
            elementId: string;
            patch: Partial<RefreshBindingState>;
          };
          setRefreshBindings((prev) =>
            prev.map((b) =>
              b.elementId === patchId ? { ...b, ...patch } : b
            )
          );
          break;
        }
        case "canvas.updateEdgeData": {
          // Update edge data (e.g., lastActivity for wire pulse animation)
          const { edgeId: ueId, updates: ueUpdates } = msg.data;
          setEdges((eds) =>
            eds.map((e) =>
              e.id === ueId ? { ...e, data: { ...(e.data || {}), ...ueUpdates } } : e
            )
          );
          break;
        }
        case "canvas.deliverMessage": {
          // Route an inter-frame message to a specific target iframe
          const { targetElementId, channel, payload } = msg.data;
          const targetIframe = document.querySelector(
            `iframe[data-element-id="${targetElementId}"]`
          ) as HTMLIFrameElement | null;
          if (targetIframe?.contentWindow) {
            targetIframe.contentWindow.postMessage(
              { type: "jet:message", channel, payload },
              "*"
            );
          }
          break;
        }
        case "canvas.c2Changed": {
          const { enabled, c2 } = msg.data;
          setC2Enabled(!!enabled);
          setC2WireCount(c2?.wires?.length ?? 0);
          break;
        }
        case "canvas.getState": {
          debouncedSaveRef.current();
          break;
        }
        case "canvas.requestState": {
          // Respond IMMEDIATELY with current React state — no debounce
          const { requestId } = msg.data;
          vscode.postMessage({
            type: "canvas.stateResponse",
            data: { requestId, state: serializeStateRef.current() },
          });
          break;
        }
        case "canvas.fileServerReady": {
          const { fileUrlBase: fub } = msg.data as { fileUrlBase: string };
          setFileUrlBase(fub);
          break;
        }
        case "canvas.frameQueryResult": {
          // Route DuckDB query result back into the requesting iframe
          const { elementId: fqElId, requestId: fqReqId, rows: fqRows, error: fqError } = msg.data;
          const fqIframe = document.querySelector(
            `iframe[data-element-id="${fqElId}"]`
          ) as HTMLIFrameElement | null;
          if (fqIframe?.contentWindow) {
            fqIframe.contentWindow.postMessage(
              { type: "jet:queryResult", requestId: fqReqId, rows: fqRows, error: fqError },
              "*"
            );
          }
          break;
        }
      }
    };
    window.addEventListener("message", handler);

    // Signal to extension that React is ready to receive messages (only once)
    if (!readySentRef.current) {
      readySentRef.current = true;
      console.log("[JET-ready] sending canvas.ready");
      vscode.postMessage({ type: "canvas.ready" });
    }

    return () => window.removeEventListener("message", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setNodes, setEdges]);

  // Force-repaint all iframes when webview panel becomes visible (fixes blank frames after tab switch)
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === "visible") {
        const iframes = document.querySelectorAll<HTMLIFrameElement>("iframe[data-element-id]");
        iframes.forEach((iframe) => { iframe.style.display = "none"; });
        setTimeout(() => {
          iframes.forEach((iframe) => { iframe.style.display = ""; });
          window.dispatchEvent(new Event("resize"));
        }, 150);
      }
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, []);

  // Listen for jet:query messages from child iframes and route to extension
  useEffect(() => {
    const iframeHandler = (event: MessageEvent) => {
      // Only handle messages from child iframes (not from extension or self)
      if (event.source === window || !event.data?.type) return;
      // Find which canvas element owns this iframe
      const findSourceElementId = (): string | null => {
        const iframes = document.querySelectorAll("iframe[data-element-id]");
        let found: string | null = null;
        iframes.forEach((iframe) => {
          if ((iframe as HTMLIFrameElement).contentWindow === event.source) {
            found = iframe.getAttribute("data-element-id");
          }
        });
        return found;
      };

      if (event.data.type === "jet:query") {
        const elementId = findSourceElementId();
        if (elementId) {
          vscode.postMessage({
            type: "canvas.frameQuery",
            data: {
              elementId,
              requestId: event.data.requestId,
              sql: event.data.sql,
            },
          });
        }
      }

      // C2: inter-frame message send
      if (event.data.type === "jet:send") {
        const elementId = findSourceElementId();
        if (elementId) {
          vscode.postMessage({
            type: "canvas.frameSend",
            data: {
              sourceElementId: elementId,
              channel: event.data.channel,
              payload: event.data.payload,
            },
          });
        }
      }

      // C2: frame declares its ports
      if (event.data.type === "jet:declarePorts") {
        const elementId = findSourceElementId();
        if (elementId) {
          vscode.postMessage({
            type: "canvas.frameDeclarePorts",
            data: {
              elementId,
              manifest: event.data.manifest,
            },
          });
        }
      }
    };
    window.addEventListener("message", iframeHandler);
    return () => window.removeEventListener("message", iframeHandler);
  }, []);

  // Broadcast fileUrlBase to all rendered frame iframes (handles late-start)
  useEffect(() => {
    if (!fileUrlBase) return;
    const iframes = document.querySelectorAll<HTMLIFrameElement>("iframe[data-element-id]");
    iframes.forEach((iframe) => {
      try {
        iframe.contentWindow?.postMessage(
          { type: "jet:fileServerReady", fileUrlBase },
          "*"
        );
      } catch { /* cross-origin, ignore */ }
    });
  }, [fileUrlBase]);

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    vscode.postMessage({
      type: "canvas.selectElement",
      data: { id: node.id, type: node.type, data: node.data },
    });
  }, []);

  const deleteNode = useCallback(
    (id: string) => {
      setNodes((nds) => nds.filter((n) => n.id !== id));
      setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
      vscode.postMessage({ type: "canvas.removeElement", data: { id } });
      // Auto-remove binding if element had one
      if (refreshBindings.some((b) => b.elementId === id)) {
        setRefreshBindings((prev) => prev.filter((b) => b.elementId !== id));
        vscode.postMessage({ type: "canvas.unbindElement", data: { elementId: id } });
      }
    },
    [setNodes, setEdges, refreshBindings]
  );

  // Keep module-level ref in sync so wrapped nodes can call deleteNode
  deleteNodeRef = deleteNode;

  // Share: post message to extension for sharing a frame element
  const shareNode = useCallback((id: string) => {
    vscode.postMessage({ type: "canvas.shareElement", data: { elementId: id } });
  }, []);
  shareNodeRef = shareNode;

  // Toggle binding pause/resume
  const toggleBinding = useCallback((id: string) => {
    vscode.postMessage({ type: "canvas.toggleBinding", data: { elementId: id } });
  }, []);
  toggleBindingRef = toggleBinding;

  // Open element in browser via live preview server
  const openInBrowser = useCallback((id: string) => {
    const node = nodes.find((n) => n.id === id);
    if (!node) return;
    const data = node.data as Record<string, unknown>;
    vscode.postMessage({
      type: "canvas.openInBrowser",
      data: {
        nodeId: id,
        html: (data.html as string) || "",
        title: (data.title as string) || (data.label as string) || id,
      },
    });
  }, [nodes]);
  openInBrowserRef = openInBrowser;

  // Open canvas in companion web app
  const openInCompanion = useCallback(() => {
    vscode.postMessage({ type: "canvas.openInCompanion" });
  }, []);
  openInCompanionRef = openInCompanion;

  // Open note/file in IDE editor
  const openInEditor = useCallback((id: string) => {
    const node = nodes.find((n) => n.id === id);
    if (!node) return;
    const data = node.data as Record<string, unknown>;
    if (typeof data._filePath === "string") {
      vscode.postMessage({
        type: "canvas.openInEditor",
        data: { filePath: data._filePath },
      });
    }
  }, [nodes]);
  openInEditorRef = openInEditor;

  // Keyboard delete for selected nodes
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't handle shortcuts when typing in an input
      if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "TEXTAREA") {
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        const selected = nodes.filter((n) => n.selected);
        selected.forEach((n) => deleteNode(n.id));
      }
      if (e.key === "v" || e.key === "V") setTool("pointer");
      if (e.key === "h" || e.key === "H") setTool("hand");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [nodes, deleteNode]);

  // Inject _binding metadata into node data so components can show a refresh indicator.
  // Also set ReactFlow's built-in `hidden` flag for nodes with _hidden data —
  // this keeps them in state (so auto-save preserves them) but prevents rendering.
  const enrichedNodes = useMemo(
    () =>
      nodes.map((n) => {
        const binding = refreshBindings.find((b) => b.elementId === n.id);
        const isHidden = !!(n.data as Record<string, unknown>)?._hidden;
        const needsEnrich = binding || isHidden || c2Enabled;
        if (!needsEnrich) return n;
        return {
          ...n,
          ...(isHidden ? { hidden: true } : {}),
          data: {
            ...n.data,
            ...(binding
              ? {
                  _binding: {
                    enabled: binding.enabled,
                    lastRun: binding.lastRun,
                    lastError: binding.lastError,
                  },
                }
              : {}),
            ...(c2Enabled ? { _c2: true } : {}),
          },
        };
      }),
    [nodes, refreshBindings, c2Enabled]
  );

  // C2 toggle — sends message to extension to enable/disable C2 mode
  const toggleC2 = useCallback(() => {
    if (!canvasIdRef.current) return;
    vscode.postMessage({
      type: "canvas.toggleC2",
      data: { canvasId: canvasIdRef.current },
    });
  }, []);

  const hasNodes = nodes.length > 0;

  const canvasApi = React.useMemo(() => ({ postMessage: (msg: unknown) => vscode.postMessage(msg), fileUrlBase }), [fileUrlBase]);

  return (
    <CanvasContext.Provider value={canvasApi}>
    <div style={{ width: "100vw", height: "100vh" }}>
      <ReactFlow
        className={`${c2Enabled ? "c2-active" : ""} ${tool === "hand" ? "tool-hand" : ""}`.trim() || undefined}
        nodes={enrichedNodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={tool === "pointer" ? onNodeClick : undefined}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={tool === "pointer"}
        elementsSelectable={tool === "pointer"}
        panOnDrag={tool === "hand"}
        selectionOnDrag={tool === "pointer"}
        fitView={hasNodes}
        minZoom={0.1}
        maxZoom={4}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        defaultEdgeOptions={{
          style: { stroke: "#404040", strokeDasharray: "5 5" },
        }}
        proOptions={{ hideAttribution: true }}
        colorMode="dark"
      >
        <Background
          variant={c2Enabled ? BackgroundVariant.Lines : BackgroundVariant.Dots}
          gap={c2Enabled ? 40 : 24}
          size={c2Enabled ? 0.3 : 1.5}
          color={c2Enabled ? "rgba(222,191,202,0.08)" : "#444444"}
        />
      </ReactFlow>
      {/* C2 mode visual overlay */}
      {c2Enabled && (
        <>
          {/* Subtle border glow */}
          <div
            style={{
              position: "fixed",
              inset: 0,
              pointerEvents: "none",
              border: "1px solid rgba(222,191,202,0.15)",
              boxShadow: "inset 0 0 60px rgba(222,191,202,0.03)",
              zIndex: 50,
            }}
          />
          {/* Status badge — top-left */}
          <div
            style={{
              position: "fixed",
              top: 10,
              left: 12,
              display: "flex",
              alignItems: "center",
              gap: 6,
              background: "rgba(222,191,202,0.08)",
              border: "1px solid rgba(222,191,202,0.2)",
              borderRadius: 6,
              padding: "4px 10px",
              zIndex: 100,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10,
              fontWeight: 600,
              color: "#DEBFCA",
              letterSpacing: "0.05em",
              textTransform: "uppercase",
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "#DEBFCA",
                animation: "c2pulse 2s ease-in-out infinite",
              }}
            />
            C2 Active
            {c2WireCount > 0 && (
              <span style={{ color: "rgba(222,191,202,0.6)", fontWeight: 400 }}>
                · {c2WireCount} wire{c2WireCount !== 1 ? "s" : ""}
              </span>
            )}
          </div>
        </>
      )}
      <CanvasToolbar
        c2Enabled={c2Enabled}
        c2WireCount={c2WireCount}
        isProjectCanvas={isProjectCanvasRef.current}
        onToggleC2={toggleC2}
        onRefreshFrames={() => {
          // Tell the extension to reload this webview panel — same effect as switching tabs
          vscode.postMessage({ type: "canvas.reloadWebview" });
        }}
        tool={tool}
        onToolChange={setTool}
      />
      {/* Channel picker for C2 wire creation */}
      {pendingConnection && (
        <ChannelPicker
          position={pendingConnection.position}
          onSelect={handleChannelSelect}
        />
      )}
      {!hasNodes && (
        <div
          style={{
            position: "fixed",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            textAlign: "center",
            pointerEvents: "none",
            opacity: 0.3,
          }}
        >
          <div style={{ fontSize: 32, marginBottom: 8 }}>&#9638;</div>
          <div style={{ fontSize: 13, fontFamily: "'Inter', sans-serif" }}>
            {displayName}
          </div>
          <div style={{ fontSize: 11, marginTop: 4, fontFamily: "'Inter', sans-serif" }}>
            Ask the agent to add analysis elements
          </div>
        </div>
      )}
    </div>
    </CanvasContext.Provider>
  );
}
