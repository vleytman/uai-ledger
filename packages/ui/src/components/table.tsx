import * as React from "react"
import { cn } from "cn"
import { FluidHoverHighlight, useFluidHover, useRegisterFluidHoverItem } from "../fluid-hover"

const TableHoverContext = React.createContext<{
  registerItem: (index: number, element: HTMLElement | null) => void
  activeIndex: number | null
} | null>(null)

function Table({ className, ...props }: React.ComponentProps<"table">) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const hover = useFluidHover(containerRef, { gapClick: false })
  const context = React.useMemo(() => ({ registerItem: hover.registerItem, activeIndex: hover.activeIndex }), [hover.registerItem, hover.activeIndex])
  return (
    <div
      data-slot="table-container"
      ref={containerRef}
      className="relative w-full overflow-x-auto"
      {...hover.handlers}
    >
      <FluidHoverHighlight hover={hover} className="z-0 bg-[var(--hover)]" />
      <TableHoverContext.Provider value={context}>
        <table
          data-slot="table"
          className={cn("relative z-10 w-full caption-bottom text-sm", className)}
          {...props}
        />
      </TableHoverContext.Provider>
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b", className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, fluidIndex, ref, ...props }: React.ComponentProps<"tr"> & { fluidIndex?: number }) {
  const internalRef = React.useRef<HTMLTableRowElement>(null)
  const context = React.useContext(TableHoverContext)
  useRegisterFluidHoverItem(context?.registerItem, fluidIndex, internalRef)
  const isActive = fluidIndex !== undefined && context?.activeIndex === fluidIndex
  return (
    <tr
      data-slot="table-row"
      data-fluid-hover-index={fluidIndex}
      data-fluid-hover-active={isActive || undefined}
      ref={node => {
        internalRef.current = node
        if (typeof ref === "function") {
          const cleanup = ref(node)
          return () => {
            internalRef.current = null
            if (typeof cleanup === "function") cleanup()
            else ref(null)
          }
        }
        if (ref) ref.current = node
        return () => {
          internalRef.current = null
          if (ref) ref.current = null
        }
      }}
      className={cn(
        "border-b transition-colors duration-80 has-aria-expanded:bg-muted data-[state=selected]:bg-muted",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-11 px-3 text-left align-middle text-xs font-medium whitespace-nowrap text-muted-foreground [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "px-3 py-3 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
