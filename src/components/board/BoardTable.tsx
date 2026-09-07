"use client";

import { useCallback, useState } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { ChevronUp, ChevronDown, ChevronsUpDown, Search, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePersistedView } from "@/hooks/use-page-state";
import { parseTableView, type TableView } from "@/lib/page-drafts";

interface BoardTableProps<T> {
  data: T[];
  columns: ColumnDef<T, unknown>[];
  pageSize?: number;
  searchPlaceholder?: string;
  onRowClick?: (row: T) => void;
  emptyMessage?: string;
  /**
   * Remember this table's search box and sort for this user, under this key.
   * Omit and the table behaves exactly as it always has, resetting on every
   * visit.
   */
  stateKey?: string;
}

const EMPTY_VIEW: TableView = { v: 1, q: "", sort: [] };

/**
 * Two shells around one table, chosen by whether a stateKey was given.
 *
 * A conditional hook is not allowed, and the alternative (always calling the
 * persistence hook with a placeholder key) would read and write rows for tables
 * that never asked to be remembered. Splitting the component keeps both paths
 * honest; stateKey is fixed per call site, so nothing ever swaps between them.
 */
export default function BoardTable<T>(props: BoardTableProps<T>) {
  return props.stateKey ? (
    <PersistedBoardTable {...props} stateKey={props.stateKey} />
  ) : (
    <LocalBoardTable {...props} />
  );
}

function LocalBoardTable<T>(props: BoardTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  return (
    <BoardTableView
      {...props}
      sorting={sorting}
      onSortingChange={setSorting}
      globalFilter={globalFilter}
      onGlobalFilterChange={setGlobalFilter}
    />
  );
}

function PersistedBoardTable<T>({ stateKey, ...props }: BoardTableProps<T> & { stateKey: string }) {
  const [view, setView] = usePersistedView<TableView>(stateKey, EMPTY_VIEW, parseTableView);

  // TanStack hands either the next value or a function of the current one.
  const onSortingChange = useCallback(
    (updater: SortingState | ((old: SortingState) => SortingState)) => {
      setView({
        v: 1,
        q: view.q,
        sort: typeof updater === "function" ? updater(view.sort) : updater,
      });
    },
    [setView, view],
  );

  const onGlobalFilterChange = useCallback(
    (updater: string | ((old: string) => string)) => {
      setView({
        v: 1,
        q: typeof updater === "function" ? updater(view.q) : updater,
        sort: view.sort,
      });
    },
    [setView, view],
  );

  return (
    <BoardTableView
      {...props}
      sorting={view.sort}
      onSortingChange={onSortingChange}
      globalFilter={view.q}
      onGlobalFilterChange={onGlobalFilterChange}
    />
  );
}

function BoardTableView<T>({
  data,
  columns,
  pageSize = 25,
  searchPlaceholder = "Search...",
  onRowClick,
  emptyMessage = "No records found",
  sorting,
  onSortingChange,
  globalFilter,
  onGlobalFilterChange,
}: Omit<BoardTableProps<T>, "stateKey"> & {
  sorting: SortingState;
  onSortingChange: (updater: SortingState | ((old: SortingState) => SortingState)) => void;
  globalFilter: string;
  onGlobalFilterChange: (updater: string | ((old: string) => string)) => void;
}) {
  // The page index is deliberately NOT remembered. TanStack resets it whenever
  // the row model changes, so a restored sort or search immediately writes
  // page 0 back, and forcing it past that would land someone on a page a
  // shrunken board no longer has. Same reasoning that keeps paging cursors out
  // of the quotes tab bar.
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize });

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    state: { sorting, globalFilter, pagination },
    onSortingChange,
    onGlobalFilterChange,
    onPaginationChange: setPagination,
  });

  return (
    <div className="flex flex-col gap-3">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#4b5563]" />
        <input
          value={globalFilter}
          onChange={(e) => onGlobalFilterChange(e.target.value)}
          placeholder={searchPlaceholder}
          className="w-full pl-8 pr-3 py-2 bg-[#1e1e1e] border border-[#2a2a2a] rounded-lg text-base sm:text-sm text-[#e5e5e5] placeholder-[#4b5563] focus:outline-none focus:border-[#FF7026]/50 transition-colors"
        />
      </div>

      {/* Table */}
      <div className="overflow-auto rounded-lg border border-[#2a2a2a]">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id} className="border-b border-[#2a2a2a] bg-[#161616]">
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    className={cn(
                      "px-4 py-3 text-left text-xs font-medium text-[#6b7280] uppercase tracking-wider whitespace-nowrap",
                      header.column.getCanSort() && "cursor-pointer select-none hover:text-[#e5e5e5] transition-colors"
                    )}
                    onClick={header.column.getToggleSortingHandler()}
                  >
                    <span className="inline-flex items-center gap-1">
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {header.column.getCanSort() && (
                        <span className="text-[#4b5563]">
                          {header.column.getIsSorted() === "asc" ? (
                            <ChevronUp className="w-3 h-3" />
                          ) : header.column.getIsSorted() === "desc" ? (
                            <ChevronDown className="w-3 h-3" />
                          ) : (
                            <ChevronsUpDown className="w-3 h-3 opacity-50" />
                          )}
                        </span>
                      )}
                    </span>
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-4 py-12 text-center text-[#4b5563] text-sm"
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  onClick={() => onRowClick?.(row.original)}
                  className={cn(
                    "border-b border-[#1e1e1e] last:border-0 hover:bg-[#1a1a1a] transition-colors",
                    onRowClick && "cursor-pointer"
                  )}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-4 py-3 text-[#e5e5e5] whitespace-nowrap">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {table.getPageCount() > 1 && (
        <div className="flex items-center justify-between text-sm text-[#6b7280]">
          <span>
            {table.getState().pagination.pageIndex * pageSize + 1}–
            {Math.min((table.getState().pagination.pageIndex + 1) * pageSize, table.getFilteredRowModel().rows.length)} of{" "}
            {table.getFilteredRowModel().rows.length}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
              className="p-2.5 sm:p-1.5 rounded hover:bg-[#1e1e1e] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
              className="p-2.5 sm:p-1.5 rounded hover:bg-[#1e1e1e] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
