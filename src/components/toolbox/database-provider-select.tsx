import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { listDatabaseProviders } from "@/lib/database/provider-registry";
import type { DatabaseProviderId } from "@/lib/database/types";

export function DatabaseProviderSelect({ value, disabled, onValueChange }: {
  readonly value: DatabaseProviderId;
  readonly disabled?: boolean;
  readonly onValueChange: (providerId: DatabaseProviderId) => void;
}) {
  return <Select value={value} disabled={disabled} onValueChange={(providerId) => onValueChange(providerId as DatabaseProviderId)}><SelectTrigger aria-label="Database provider" data-testid="database-provider-select"><SelectValue /></SelectTrigger><SelectContent>{listDatabaseProviders().map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.displayName}</SelectItem>)}</SelectContent></Select>;
}
