/** A persisted connection definition, deliberately separate from live sessions. */
export interface DatabaseConnectionProfile<
  TProviderId extends string,
  TProviderConfig,
> {
  readonly id: string;
  readonly name: string;
  readonly providerId: TProviderId;
  readonly group?: string;
  readonly environment: "development" | "test" | "production";
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly providerConfig: TProviderConfig;
}
