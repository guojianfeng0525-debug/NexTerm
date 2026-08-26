import type { DatabaseConnectionProfile } from "./profile-types";

export interface SQLiteConnectionConfig {
  readonly filePath: string;
  readonly readOnly: boolean;
  /** Optional connection accent color (B22), `#RRGGBB`. */
  readonly color?: string;
}

export type SQLiteConnectionProfile = DatabaseConnectionProfile<
  "sqlite",
  SQLiteConnectionConfig
>;
