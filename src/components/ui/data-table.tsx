"use client"

import * as React from "react"
import {
    ColumnDef,
    flexRender,
    getCoreRowModel,
    getPaginationRowModel,
    useReactTable,
} from "@tanstack/react-table"
import { Button } from "@/components/ui/button"
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { motion, AnimatePresence } from "framer-motion"
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react"

interface DataTableProps<TData, TValue> {
    columns: ColumnDef<TData, TValue>[]
    data: TData[]
    className?: string
    stickyFirstColumn?: boolean
    stickyHeader?: boolean
}

export function DataTable<TData, TValue>({
    columns,
    data,
    className,
    stickyFirstColumn = true,
    stickyHeader = true,
}: DataTableProps<TData, TValue>) {
    const table = useReactTable({
        data,
        columns,
        getCoreRowModel: getCoreRowModel(),
        getPaginationRowModel: getPaginationRowModel(),
        initialState: {
            pagination: {
                pageSize: 100,
            },
        },
    })

    return (
        <div className={cn("flex flex-col gap-2 h-full w-full", className)}>
            <div className="relative flex-1 w-full overflow-auto rounded-xs border border-ink-500 bg-ink-100">
                <table className="border-collapse min-w-full w-max table-auto text-sm">
                    <thead
                        className={cn(
                            "z-40 border-b border-ink-500",
                            stickyHeader && "sticky top-0"
                        )}
                    >
                        {table.getHeaderGroups().map((headerGroup) => (
                            <tr
                                key={headerGroup.id}
                                className="border-0 h-10 bg-ink-200 transition-colors"
                            >
                                {headerGroup.headers.map((header, index) => {
                                    const isFirst = index === 0 && stickyFirstColumn;
                                    return (
                                        <th
                                            key={header.id}
                                            className={cn(
                                                "p-0 border-r border-ink-500/60 last:border-r-0 font-mono text-[10px] uppercase tracking-[0.14em] text-paper-muted transition-colors",
                                                isFirst && "sticky left-0 z-50 bg-ink-200"
                                            )}
                                        >
                                            <div className="h-full w-full flex items-center px-3">
                                                {header.isPlaceholder
                                                    ? null
                                                    : flexRender(
                                                        header.column.columnDef.header,
                                                        header.getContext()
                                                    )}
                                            </div>
                                        </th>
                                    )
                                })}
                            </tr>
                        ))}
                    </thead>
                    <tbody className="bg-transparent text-paper">
                        <AnimatePresence mode="popLayout" initial={false}>
                            {table.getRowModel().rows?.length ? (
                                table.getRowModel().rows.map((row, rowIndex) => (
                                    <motion.tr
                                        key={row.id}
                                        initial={{ opacity: 0, y: 4 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0, scale: 0.98 }}
                                        transition={{
                                            duration: 0.2,
                                            delay: Math.min(rowIndex * 0.02, 0.4),
                                            ease: "easeOut"
                                        }}
                                        className={cn(
                                            "group transition-colors duration-150 border-b border-ink-500/40 hover:bg-ink-200 last:border-b-0 h-9",
                                            row.getIsSelected() && "bg-ink-200"
                                        )}
                                    >
                                        {row.getVisibleCells().map((cell, cellIndex) => {
                                            const isFirst = cellIndex === 0 && stickyFirstColumn;
                                            const meta = cell.column.columnDef.meta as { wrap?: boolean } | undefined;
                                            return (
                                                <td
                                                    key={cell.id}
                                                    className={cn(
                                                        "p-0 px-3 h-full align-middle border-r border-ink-500/30 last:border-r-0 py-2 transition-colors",
                                                        isFirst && "sticky left-0 z-20 bg-ink-100 group-hover:bg-ink-200",
                                                        meta?.wrap ? "whitespace-normal min-w-[300px]" : "whitespace-nowrap"
                                                    )}
                                                >
                                                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                                </td>
                                            );
                                        })}
                                    </motion.tr>
                                ))
                            ) : (
                                <tr>
                                    <td colSpan={columns.length} className="h-24 text-center text-paper-faint italic font-light">
                                        No results found.
                                    </td>
                                </tr>
                            )}
                        </AnimatePresence>
                    </tbody>
                </table>
            </div>

            <div className="flex items-center justify-between px-2 py-2 border-t border-ink-500 bg-ink-100">
                <div className="flex items-center space-x-2">
                    <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-paper-muted">Rows per page</p>
                    <Select
                        value={`${table.getState().pagination.pageSize}`}
                        onValueChange={(value) => {
                            table.setPageSize(Number(value))
                        }}
                    >
                        <SelectTrigger className="h-7 w-[70px] bg-ink-200 border-ink-500 text-xs">
                            <SelectValue placeholder={table.getState().pagination.pageSize} />
                        </SelectTrigger>
                        <SelectContent side="top">
                            {[10, 20, 30, 50, 100].map((pageSize) => (
                                <SelectItem key={pageSize} value={`${pageSize}`} className="text-xs">
                                    {pageSize}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <div className="flex items-center space-x-6 lg:space-x-8">
                    <div className="flex w-[100px] items-center justify-center font-mono text-[11px] text-paper-muted">
                        Page {table.getState().pagination.pageIndex + 1} of{" "}
                        {table.getPageCount()}
                    </div>
                    <div className="flex items-center space-x-1.5">
                        <Button
                            variant="outline"
                            className="hidden h-7 w-7 p-0 lg:flex bg-ink-200 border-ink-500 text-paper-muted hover:bg-ink-300 hover:text-paper"
                            onClick={() => table.setPageIndex(0)}
                            disabled={!table.getCanPreviousPage()}
                        >
                            <span className="sr-only">Go to first page</span>
                            <ChevronsLeft className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                            variant="outline"
                            className="h-7 w-7 p-0 bg-ink-200 border-ink-500 text-paper-muted hover:bg-ink-300 hover:text-paper"
                            onClick={() => table.previousPage()}
                            disabled={!table.getCanPreviousPage()}
                        >
                            <span className="sr-only">Go to previous page</span>
                            <ChevronLeft className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                            variant="outline"
                            className="h-7 w-7 p-0 bg-ink-200 border-ink-500 text-paper-muted hover:bg-ink-300 hover:text-paper"
                            onClick={() => table.nextPage()}
                            disabled={!table.getCanNextPage()}
                        >
                            <span className="sr-only">Go to next page</span>
                            <ChevronRight className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                            variant="outline"
                            className="hidden h-7 w-7 p-0 lg:flex bg-ink-200 border-ink-500 text-paper-muted hover:bg-ink-300 hover:text-paper"
                            onClick={() => table.setPageIndex(table.getPageCount() - 1)}
                            disabled={!table.getCanNextPage()}
                        >
                            <span className="sr-only">Go to last page</span>
                            <ChevronsRight className="h-3.5 w-3.5" />
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    )
}
