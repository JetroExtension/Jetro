export interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

export interface SchemaTree {
  schemas: SchemaNode[];
}

export interface SchemaNode {
  name: string;
  tables: TableNode[];
}

export interface TableNode {
  name: string;
  rowCount?: number;
  columns: ColumnNode[];
}

export interface ColumnNode {
  name: string;
  type: string;
  nullable: boolean;
  isPrimaryKey: boolean;
}
