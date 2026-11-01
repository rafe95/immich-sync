<script lang="ts">
  import type { Snippet } from "svelte";
  import { Dialog } from "@skeletonlabs/skeleton-svelte";

  /**
   * Modal confirmation on Skeleton's Dialog. Escape, the backdrop and Cancel call `oncancel`; focus is trapped
   * while open and returns to the previously focused element on close. The caller owns `open` and closes it
   * from `onconfirm`/`oncancel`.
   */
  let {
    open,
    title,
    children,
    confirmLabel,
    cancelLabel = "Cancel",
    tone = "primary",
    busy = false,
    onconfirm,
    oncancel,
  }: {
    open: boolean;
    title: string;
    children?: Snippet;
    confirmLabel: string;
    cancelLabel?: string;
    tone?: "primary" | "danger";
    busy?: boolean;
    onconfirm: () => void;
    oncancel: () => void;
  } = $props();
</script>

<Dialog {open} role="alertdialog" onOpenChange={(d) => { if (!d.open) oncancel(); }}>
  {#if open}
    <Dialog.Backdrop class="fixed inset-0 z-50 bg-surface-950/50" />
    <Dialog.Positioner class="fixed inset-0 z-50 flex items-center justify-center p-4">
      <Dialog.Content class="card preset-filled-surface-100-900 w-full max-w-lg space-y-3 p-5 shadow-xl">
        <Dialog.Title class="h5">{title}</Dialog.Title>
        <Dialog.Description class="space-y-2">{@render children?.()}</Dialog.Description>
        <div class="flex flex-wrap justify-end gap-2">
          <Dialog.CloseTrigger class="btn preset-tonal-surface" disabled={busy}>{cancelLabel}</Dialog.CloseTrigger>
          <button type="button" class="btn {tone === 'danger' ? 'preset-filled-error-500' : 'preset-filled-primary-500'}" disabled={busy} onclick={onconfirm}>{confirmLabel}</button>
        </div>
      </Dialog.Content>
    </Dialog.Positioner>
  {/if}
</Dialog>
