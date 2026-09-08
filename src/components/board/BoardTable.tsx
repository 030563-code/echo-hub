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
  /**
   * The board surface this table sits on. Dark by default, because Purchase
   * Orders and MRP were built that way and are not changing here. Transport
   * passes false; converting the other modules is a separate job.
   */
  dark?: boolean;
}

const EMPTY_VIEW: TableView = { v: 1, q: "", sort: [] };

/**
 * One palette per surface, so a colour cannot be half-converted. Same
 * convention as search-box.tsx, empty-state.tsx and draft-strip.tsx.
 */
const SKIN = {
  dark: {
    searchIcon: "text-[#4b5563]",
    input:
      "bg-[#1e1e1e] border-[#2a2a2a] text-[#e5e5e5] placeholder-[#4b5563] focus:border-[#FF7026]/50",
    frame: "border-[#2a2a2a]",
    headRow: "border-[#2a2a2a] bg-[#161616]",
    headCell: "text-[#6b7280]",
    headCellHover: "hover:text-[#e5e5e5]",
    sortIcon: "text-[#4b5563]",
    empty: "text-[#4b5563]",
    bodyRow: "border-[#1e1e1e] hover:bg-[#1a1a1a]",
    bodyCell: "text-[#e5e5e5]",
    pager: "text-[#6b7280]",
    pagerHover: "hover:bg-[#1e1e1e]",
  },
  light: {
    searchIcon: "text-gray-400",
    input:
      "bg-white border-gray-300 text-gray-900 placeholder-gray-400 focus:border-echo-orange/60",
    frame: "border-gray-200",
    headRow: "border-gray-200 bg-gray-50",
    headCell: "text-gray-500",
    headCellHover: "hover:text-gray-900",
    sortIcon: "text-gray-400",
    empty: "text-gray-400",
    bodyRow: "border-gray-100 hover:bg-gray-50",
    bodyCell: "text-gray-900",
    pager: "text-gray-600",
    pagerHover: "hover:bg-gray-100",
  },
} as const;

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
  dark = true,
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
  const skin = dark ? SKIN.dark : SKIN.light;

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
        <Search className={cn("absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5", skin.searchIcon)} />
        <input
          value={globalFilter}
          onChange={(e) => onGlobalFilterChange(e.target.value)}
          placeholder={searchPlaceholder}
          className={cn(
            "w-full pl-8 pr-3 py-2 border rounded-lg text-base sm:text-sm focus:outline-none transition-colors",
            skin.input,
          )}
        />
      </div>

      {/* Table */}
      <div className={cn("overflow-auto rounded-lg border", skin.frame)}>
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id} className={cn("border-b", skin.headRow)}>
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    className={cn(
                      "px-4 py-3 text-left text-xs font-medium uppercase tracking-wider whitespace-nowrap",
                      skin.headCell,
                      header.column.getCanSort() &&
                        cn("cursor-pointer select-none transition-colors", skin.headCellHover)
                    )}
                    onClick={header.column.getToggleSortingHandler()}
                  >
                    <span className="inline-flex items-center gap-1">
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {header.column.getCanSort() && (
                        <span className={skin.sortIcon}>
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
                  className={cn("px-4 py-12 text-center text-sm", skin.empty)}
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
                    "border-b last:border-0 transition-colors",
                    skin.bodyRow,
                    onRowClick && "cursor-pointer"
                  )}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className={cn("px-4 py-3 whitespace-nowrap", skin.bodyCell)}>
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
        <div className={cn("flex items-center justify-between text-sm", skin.pager)}>
          <span>
            {table.getState().pagination.pageIndex * pageSize + 1}–
            {Math.min((table.getState().pagination.pageIndex + 1) * pageSize, table.getFilteredRowModel().rows.length)} of{" "}
            {table.getFilteredRowModel().rows.length}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
              className={cn("p-2.5 sm:p-1.5 rounded disabled:opacity-40 disabled:cursor-not-allowed transition-colors", skin.pagerHover)}
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
              className={cn("p-2.5 sm:p-1.5 rounded disabled:opacity-40 disabled:cursor-not-allowed transition-colors", skin.pagerHover)}
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
