import { createContext, useContext } from "react";

interface CanvasApi {
  postMessage(msg: unknown): void;
  fileUrlBase: string;
}

export const CanvasContext = createContext<CanvasApi>({
  postMessage: () => {},
  fileUrlBase: "",
});

export function useCanvasApi(): CanvasApi {
  return useContext(CanvasContext);
}
