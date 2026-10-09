import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

interface UseInlineRenameReturn {
  renamingPath: string | null;
  renameValue: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  startRename: (path: string, currentName: string) => void;
  cancelRename: () => void;
  confirmRename: () => void;
  setRenameValue: (value: string) => void;
}

export function useInlineRename(
  onRename: (
    oldPath: string,
    newName: string,
  ) => Promise<void>,
): UseInlineRenameReturn {
  const [renamingPath, setRenamingPath] = useState<
    string | null
  >(null);
  const [renameValue, setRenameValue] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pendingSelectRef = useRef(false);
  const originalNameRef = useRef('');

  const startRename = useCallback(
    (path: string, currentName: string) => {
      const lastDot = currentName.lastIndexOf('.');
      const stem =
        lastDot > 0
          ? currentName.slice(0, lastDot)
          : currentName;
      setRenamingPath(path);
      setRenameValue(stem);
      originalNameRef.current = stem;
      pendingSelectRef.current = true;
    },
    [],
  );

  const cancelRename = useCallback(() => {
    setRenamingPath(null);
    setRenameValue('');
    pendingSelectRef.current = false;
  }, []);

  const confirmRename = useCallback(() => {
    if (!renamingPath) return;
    const trimmed = renameValue.trim();
    if (
      trimmed.length === 0 ||
      trimmed === originalNameRef.current
    ) {
      cancelRename();
      return;
    }
    void onRename(renamingPath, trimmed).finally(() => {
      cancelRename();
    });
  }, [renamingPath, renameValue, onRename, cancelRename]);

  useEffect(() => {
    if (!renamingPath || !pendingSelectRef.current) return;
    if (inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
      pendingSelectRef.current = false;
    } else {
      const raf = requestAnimationFrame(() => {
        if (inputRef.current && pendingSelectRef.current) {
          inputRef.current.focus();
          inputRef.current.select();
          pendingSelectRef.current = false;
        }
      });
      return () => cancelAnimationFrame(raf);
    }
  });

  return {
    renamingPath,
    renameValue,
    inputRef,
    startRename,
    cancelRename,
    confirmRename,
    setRenameValue,
  };
}
