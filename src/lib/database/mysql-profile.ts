import type { DatabaseConnectionProfile } from "./profile-types";

export interface MySQLConnectionConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password?: string;
}

export type MySQLConnectionProfile = DatabaseConnectionProfile<"mysql", MySQLConnectionConfig>;

export function isValidMySQLPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}
