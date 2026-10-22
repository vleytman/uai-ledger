# TanStack Start + shadcn/ui

The UAI admin interface uses TanStack Start, React, TypeScript, and shadcn/ui. For setup and login, follow the [local guide](../../docs/LOCAL_RUN.md). To embed UAI pages in your product's admin interface, use the [modular admin guide](../../docs/MODULAR_ADMIN.md).

## Adding components

To add a shadcn/ui component, run:

```bash
npx shadcn@latest add button
```

The command adds the UI components to the `components` directory.

## Using components

Import a component where you need it:

```tsx
import { Button } from "@/components/ui/button";
```
