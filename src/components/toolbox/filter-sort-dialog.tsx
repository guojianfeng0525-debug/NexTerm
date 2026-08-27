import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  DatabaseResultColumn,
  FilterCondition,
  FilterOperator,
  SortClause,
  TableFilterState,
} from "@/lib/database/result-types";

export const FILTER_OPERATORS: readonly FilterOperator[] = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "isNull",
  "isNotNull",
];

export interface FilterSortDialogLabels {
  readonly title: string;
  readonly conditions: string;
  readonly column: string;
  readonly operator: string;
  readonly value: string;
  /** Hint shown in the value input when the `like` operator is selected. */
  readonly valueLikeHint: string;
  /** Warning shown when a value-operator condition has an empty value. */
  readonly valueEmptyWarning: string;
  readonly addCondition: string;
  readonly removeCondition: string;
  readonly logicAnd: string;
  readonly logicOr: string;
  readonly sort: string;
  readonly addSort: string;
  readonly sortAsc: string;
  readonly sortDesc: string;
  readonly apply: string;
  readonly cancel: string;
  readonly clear: string;
  readonly operatorNames: Readonly<Record<FilterOperator, string>>;
}

interface FilterSortDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Table columns; `label` is the database column name sent to the backend. */
  readonly columns: readonly DatabaseResultColumn[];
  readonly initialFilter?: TableFilterState;
  /** When true, the ORDER BY section is shown (Filter & Sort). */
  readonly includeSort: boolean;
  readonly labels: FilterSortDialogLabels;
  readonly onApply: (filter: TableFilterState) => void;
  readonly onClear: () => void;
}

function conditionNeedsValue(operator: FilterOperator): boolean {
  return operator !== "isNull" && operator !== "isNotNull";
}

export function FilterSortDialog({
  open,
  onOpenChange,
  columns,
  initialFilter,
  includeSort,
  labels,
  onApply,
  onClear,
}: FilterSortDialogProps) {
  const [logic, setLogic] = useState<"AND" | "OR">("AND");
  const [conditions, setConditions] = useState<FilterCondition[]>([]);
  const [orderBy, setOrderBy] = useState<SortClause[]>([]);

  // Rehydrate from the applied filter each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setLogic(initialFilter?.logic ?? "AND");
    setConditions(
      initialFilter?.conditions.length
        ? initialFilter.conditions.map((condition) => ({
            column: condition.column,
            operator: condition.operator,
            value: condition.value ?? null,
          }))
        : [{ column: columns[0]?.label ?? "", operator: "eq", value: "" }],
    );
    setOrderBy(
      initialFilter?.orderBy.length
        ? initialFilter.orderBy.map((sort) => ({ ...sort }))
        : [],
    );
  }, [open, initialFilter, columns]);

  const patchCondition = (
    index: number,
    patch: Partial<FilterCondition>,
  ) =>
    setConditions((current) =>
      current.map((condition, itemIndex) =>
        itemIndex === index ? { ...condition, ...patch } : condition,
      ),
    );

  const apply = () => {
    const nonEmpty = conditions.filter(
      (condition) =>
        condition.column &&
        (conditionNeedsValue(condition.operator) ||
          condition.operator === "isNull" ||
          condition.operator === "isNotNull"),
    );
    onApply({
      logic,
      conditions: nonEmpty,
      orderBy,
    });
    onOpenChange(false);
  };

  const clear = () => {
    onClear();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{labels.title}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 py-2">
          <div>
            <Label className="mb-1 block text-[11px] text-muted-foreground">
              {labels.conditions}
            </Label>
            <div className="flex flex-col gap-1.5">
              {conditions.map((condition, index) => (
                <div key={index} className="flex items-center gap-1.5">
                  <Select
                    value={condition.column}
                    onValueChange={(column) =>
                      patchCondition(index, { column })
                    }
                  >
                    <SelectTrigger className="h-7 w-[130px] text-[12px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {columns.map((column) => (
                        <SelectItem
                          key={column.key}
                          value={column.label}
                          className="text-[12px]"
                        >
                          {column.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={condition.operator}
                    onValueChange={(operator) =>
                      patchCondition(index, {
                        operator: operator as FilterOperator,
                      })
                    }
                  >
                    <SelectTrigger className="h-7 w-[110px] text-[12px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FILTER_OPERATORS.map((operator) => (
                        <SelectItem
                          key={operator}
                          value={operator}
                          className="text-[12px]"
                        >
                          {labels.operatorNames[operator]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
              <Input
                className="h-7 flex-1 text-[12px]"
                value={condition.value ?? ""}
                disabled={!conditionNeedsValue(condition.operator)}
                placeholder={
                  condition.operator === "like"
                    ? labels.valueLikeHint
                    : labels.value
                }
                data-testid={`filter-value-input-${index}`}
                onChange={(event) =>
                  patchCondition(index, { value: event.target.value })
                }
              />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    aria-label={labels.removeCondition}
                    onClick={() =>
                      setConditions((current) =>
                        current.filter((_, itemIndex) => itemIndex !== index),
                      )
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
            {conditions.some(
              (condition) =>
                condition.column &&
                conditionNeedsValue(condition.operator) &&
                condition.value === "",
            ) && (
              <p className="mt-1 text-[11px] text-amber-600">
                {labels.valueEmptyWarning}
              </p>
            )}
            <div className="mt-1.5 flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-6 rounded-sm px-2 text-[11px]"
                onClick={() =>
                  setConditions((current) => [
                    ...current,
                    {
                      column: columns[0]?.label ?? "",
                      operator: "eq",
                      value: "",
                    },
                  ])
                }
              >
                <Plus className="mr-1 h-3 w-3" />
                {labels.addCondition}
              </Button>
              <div className="ml-auto flex items-center gap-1">
                <Button
                  type="button"
                  variant={logic === "AND" ? "default" : "ghost"}
                  size="sm"
                  className="h-6 rounded-sm px-2 text-[11px]"
                  onClick={() => setLogic("AND")}
                >
                  {labels.logicAnd}
                </Button>
                <Button
                  type="button"
                  variant={logic === "OR" ? "default" : "ghost"}
                  size="sm"
                  className="h-6 rounded-sm px-2 text-[11px]"
                  onClick={() => setLogic("OR")}
                >
                  {labels.logicOr}
                </Button>
              </div>
            </div>
          </div>
          {includeSort && (
            <div>
              <Label className="mb-1 block text-[11px] text-muted-foreground">
                {labels.sort}
              </Label>
              <div className="flex flex-col gap-1.5">
                {orderBy.map((sort, index) => (
                  <div key={index} className="flex items-center gap-1.5">
                    <Select
                      value={sort.column}
                      onValueChange={(column) =>
                        setOrderBy((current) =>
                          current.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, column } : item,
                          ),
                        )
                      }
                    >
                      <SelectTrigger className="h-7 w-[180px] text-[12px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {columns.map((column) => (
                          <SelectItem
                            key={column.key}
                            value={column.label}
                            className="text-[12px]"
                          >
                            {column.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={sort.direction}
                      onValueChange={(direction) =>
                        setOrderBy((current) =>
                          current.map((item, itemIndex) =>
                            itemIndex === index
                              ? {
                                  ...item,
                                  direction: direction as "asc" | "desc",
                                }
                              : item,
                          ),
                        )
                      }
                    >
                      <SelectTrigger className="h-7 w-[100px] text-[12px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="asc" className="text-[12px]">
                          {labels.sortAsc}
                        </SelectItem>
                        <SelectItem value="desc" className="text-[12px]">
                          {labels.sortDesc}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0"
                      aria-label={labels.removeCondition}
                      onClick={() =>
                        setOrderBy((current) =>
                          current.filter((_, itemIndex) => itemIndex !== index),
                        )
                      }
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-1.5 h-6 rounded-sm px-2 text-[11px]"
                onClick={() =>
                  setOrderBy((current) => [
                    ...current,
                    { column: columns[0]?.label ?? "", direction: "asc" },
                  ])
                }
              >
                <Plus className="mr-1 h-3 w-3" />
                {labels.addSort}
              </Button>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 rounded-sm px-3 text-[12px]"
            onClick={clear}
            data-testid="filter-clear"
          >
            {labels.clear}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 rounded-sm px-3 text-[12px]"
            onClick={() => onOpenChange(false)}
          >
            {labels.cancel}
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-7 rounded-sm px-3 text-[12px]"
            onClick={apply}
            data-testid="filter-apply"
          >
            {labels.apply}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
