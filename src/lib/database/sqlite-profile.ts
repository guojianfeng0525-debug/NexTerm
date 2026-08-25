import type { DatabaseConnectionProfile } from "./profile-types";

export interface SQLiteConnectionConfig {
  readonly filePath: string;
  readonly readOnly: boolean;
}

export type SQLiteConnectionProfile = DatabaseConnectionProfile<
  "sqlite",
  SQLiteConnectionConfig
>;
