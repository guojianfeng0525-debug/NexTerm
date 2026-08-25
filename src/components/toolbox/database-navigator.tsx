import type { ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  Database,
  ListTree,
  Table2,
} from "lucide-react";
import type {
  DatabaseObjectNode,
  DatabaseObjectNodeId,
} from "@/lib/database/types";

function nodeIcon(node: DatabaseObjectNode): ReactNode {
  switch (node.iconRole) {
    case "connection":
      return <Database className="h-3.5 w-3.5 text-primary" />;
    case "catalog":
      return <Database className="h-3.5 w-3.5" />;
    case "schema":
      return <ListTree className="h-3.5 w-3.5" />;
    case "group":
      return <Table2 className="h-3.5 w-3.5 text-primary" />;
    case "relation":
      return <Table2 className="h-3.5 w-3.5 text-muted-foreground" />;
  }
}

interface DatabaseNavigatorProps {
  readonly roots: readonly DatabaseObjectNode[];
  readonly childrenByParent: Readonly<
    Partial<Record<DatabaseObjectNodeId, readonly DatabaseObjectNode[]>>
  >;
  readonly expanded: Readonly<Partial<Record<DatabaseObjectNodeId, boolean>>>;
  readonly selectedNodeId: DatabaseObjectNodeId | null;
  readonly filter: string;
  readonly onToggle: (node: DatabaseObjectNode) => void;
  readonly onSelect: (node: DatabaseObjectNode) => void;
  readonly onOpen: (node: DatabaseObjectNode) => void;
}

export function DatabaseNavigator({
  roots,
  childrenByParent,
  expanded,
  selectedNodeId,
  filter,
  onToggle,
  onSelect,
  onOpen,
}: DatabaseNavigatorProps) {
  const normalizedFilter = filter.trim().toLowerCase();
  const renderNodes = (nodes: readonly DatabaseObjectNode[], depth: number) =>
    nodes.map((node) => {
      const isExpanded = expanded[node.id] ?? false;
      const children = childrenByParent[node.id] ?? [];
      const isFilteredRelation =
        node.objectRole === "relation" &&
        normalizedFilter.length > 0 &&
        !node.label.toLowerCase().includes(normalizedFilter);

      if (isFilteredRelation) return null;

      const selected = selectedNodeId === node.id;
      return (
        <div key={node.id}>
          <button
            type="button"
            onClick={() => {
              if (node.selectable) onSelect(node);
              if (node.expandable) onToggle(node);
              if (node.openable) onOpen(node);
            }}
            className={`flex h-6 w-full items-center gap-1 px-1 text-left text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${selected ? "bg-primary/10 text-primary" : "hover:bg-accent/70"}`}
            data-testid="database-navigator-node"
            data-node-id={node.id}
          >
            <span style={{ width: depth * 14 }} />
            {node.expandable ? (
              isExpanded ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )
            ) : (
              <span className="w-3.5" />
            )}
            {nodeIcon(node)}
            <span className="truncate">{node.label}</span>
          </button>
          {node.expandable && isExpanded && renderNodes(children, depth + 1)}
        </div>
      );
    });

  return <>{renderNodes(roots, 0)}</>;
}
