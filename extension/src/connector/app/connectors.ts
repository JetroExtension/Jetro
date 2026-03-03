export interface ConnectorDef {
  engine: string;
  label: string;
  icon: string;
  color: string;
  description: string;
  fields: ConnectorField[];
  extensions: string[];
}

export interface ConnectorField {
  key: string;
  label: string;
  type: "text" | "number" | "password" | "file" | "select";
  placeholder?: string;
  defaultValue?: string | number;
  required: boolean;
  options?: { label: string; value: string }[];
  helpText?: string;
}

export const CONNECTORS: ConnectorDef[] = [
  {
    engine: "postgres",
    label: "PostgreSQL",
    icon: "\u{1F418}",
    color: "#336791",
    description: "Connect to PostgreSQL databases",
    extensions: ["postgres_scanner"],
    fields: [
      { key: "host", label: "Host", type: "text", placeholder: "localhost", defaultValue: "localhost", required: true },
      { key: "port", label: "Port", type: "number", placeholder: "5432", defaultValue: 5432, required: true },
      { key: "database", label: "Database", type: "text", placeholder: "mydb", required: true },
      { key: "schema", label: "Username", type: "text", placeholder: "postgres", defaultValue: "postgres", required: true },
      { key: "password", label: "Password", type: "password", required: true },
    ],
  },
  {
    engine: "mysql",
    label: "MySQL",
    icon: "\u{1F42C}",
    color: "#4479A1",
    description: "Connect to MySQL or MariaDB databases",
    extensions: ["mysql_scanner"],
    fields: [
      { key: "host", label: "Host", type: "text", placeholder: "localhost", defaultValue: "localhost", required: true },
      { key: "port", label: "Port", type: "number", placeholder: "3306", defaultValue: 3306, required: true },
      { key: "database", label: "Database", type: "text", placeholder: "mydb", required: true },
      { key: "schema", label: "Username", type: "text", placeholder: "root", defaultValue: "root", required: true },
      { key: "password", label: "Password", type: "password", required: true },
    ],
  },
  {
    engine: "sqlite",
    label: "SQLite",
    icon: "\u{1F4E6}",
    color: "#003B57",
    description: "Open a local SQLite database file",
    extensions: ["sqlite_scanner"],
    fields: [
      { key: "filePath", label: "Database File", type: "file", required: true, helpText: ".db, .sqlite, .sqlite3" },
    ],
  },
  {
    engine: "duckdb_file",
    label: "DuckDB File",
    icon: "\u{1F986}",
    color: "#FFF000",
    description: "Attach an external DuckDB database file",
    extensions: [],
    fields: [
      { key: "filePath", label: "Database File", type: "file", required: true, helpText: ".duckdb" },
    ],
  },
  {
    engine: "motherduck",
    label: "MotherDuck",
    icon: "\u{2601}\u{FE0F}",
    color: "#FF6B35",
    description: "Connect to MotherDuck cloud DuckDB",
    extensions: ["motherduck"],
    fields: [
      { key: "filePath", label: "Database Path", type: "text", placeholder: "md:my_database", required: true, helpText: "Format: md:database_name" },
      { key: "password", label: "Token", type: "password", required: true, helpText: "MotherDuck access token" },
    ],
  },
  {
    engine: "s3",
    label: "Amazon S3",
    icon: "\u{2601}\u{FE0F}",
    color: "#FF9900",
    description: "Connect to S3-compatible object storage (Parquet, CSV)",
    extensions: ["httpfs"],
    fields: [
      { key: "region", label: "Region", type: "text", placeholder: "us-east-1", defaultValue: "us-east-1", required: true },
      { key: "schema", label: "Access Key ID", type: "text", required: true },
      { key: "password", label: "Secret Access Key", type: "password", required: true },
      { key: "endpoint", label: "Custom Endpoint", type: "text", required: false, helpText: "For MinIO, R2, etc." },
      { key: "filePath", label: "Bucket/Path", type: "text", placeholder: "s3://my-bucket/data/", required: true },
    ],
  },
  {
    engine: "snowflake",
    label: "Snowflake",
    icon: "\u{2744}\u{FE0F}",
    color: "#29B5E8",
    description: "Connect to Snowflake data warehouse",
    extensions: [],
    fields: [
      { key: "account", label: "Account", type: "text", placeholder: "abc12345.us-east-1", required: true },
      { key: "warehouse", label: "Warehouse", type: "text", placeholder: "COMPUTE_WH", required: true },
      { key: "database", label: "Database", type: "text", required: true },
      { key: "schema", label: "User|Schema", type: "text", placeholder: "user|public", required: true, helpText: "Format: username|schema_name" },
      { key: "password", label: "Password", type: "password", required: true },
    ],
  },
];
