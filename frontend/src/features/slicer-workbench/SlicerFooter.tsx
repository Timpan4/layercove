export interface SlicerFooterProps {
  status: string;
  plateName: string;
  objectCount: number;
  engine?: string;
  shortcutHint?: string;
}

export function SlicerFooter({ status, plateName, objectCount, engine, shortcutHint }: SlicerFooterProps) {
  return <footer className="flex h-8 shrink-0 items-center gap-4 rounded-md border border-white/10 bg-[#292a2e] px-3 text-[10px] text-bambu-gray-light"><span className="text-bambu-green">{status}</span><span>{plateName}</span><span>{objectCount} object{objectCount === 1 ? '' : 's'}</span>{engine && <span>{engine}</span>}{shortcutHint && <span className="ml-auto">{shortcutHint}</span>}</footer>;
}
