import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';

export const toolbarMenuItemClass =
  'flex w-full items-center gap-2 whitespace-nowrap rounded px-3 py-2 text-left text-sm text-white hover:bg-bambu-dark-tertiary focus:bg-bambu-dark-tertiary focus:outline-none disabled:cursor-not-allowed disabled:text-bambu-gray disabled:hover:bg-transparent';

interface ToolbarMoreMenuProps {
  label: string;
  children: ReactNode;
}

function enabledMenuItems(menu: HTMLElement | null): HTMLElement[] {
  return Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
}

// Disclosure menu for secondary toolbar actions. Items mount only while open,
// so their names are absent from the accessibility tree until the menu opens.
export function ToolbarMoreMenu({ label, children }: ToolbarMoreMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    enabledMenuItems(menuRef.current)[0]?.focus();

    const handlePointerDown = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = enabledMenuItems(menuRef.current);
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(current + 1) % items.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(current - 1 + items.length) % items.length]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div ref={wrapperRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[44px] md:min-h-0 text-sm font-medium rounded-lg bg-bambu-dark-tertiary hover:bg-bambu-gray-dark text-white transition-colors focus:outline-none focus:ring-2 focus:ring-bambu-gray focus:ring-offset-2 focus:ring-offset-bambu-dark"
      >
        <MoreHorizontal className="w-4 h-4" />
        {label}
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={handleKeyDown}
          // An item click unmounts the focused item; the trigger takes focus back so keyboard users keep
          // their place. A dialog or navigation that the action opens moves focus again afterwards.
          onClick={() => {
            setOpen(false);
            triggerRef.current?.focus();
          }}
          className="absolute right-0 z-30 mt-1 flex w-52 flex-col gap-0.5 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary p-1 shadow-lg"
        >
          {children}
        </div>
      )}
    </div>
  );
}
