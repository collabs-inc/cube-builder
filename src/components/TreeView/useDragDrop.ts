import { services } from "../../renderer/services";
import { useCallback, useRef, useState } from 'react';
import { classifyTreeDrag } from './external-drop';
import { dropContents } from '../Terminal/file-drop';

interface UseDragDropReturn {
	draggedPaths: string[] | null;
	dropTargetPath: string | null;
	externalTargetFolder: string | null;
	handleDragStart: (
		e: React.DragEvent,
		path: string,
		selectedPaths: Set<string>,
	) => void;
	handleDragOver: (
		e: React.DragEvent,
		folderPath: string,
		fileRow?: boolean,
	) => void;
	handleDragLeave: () => void;
	handleDrop: (
		e: React.DragEvent,
		targetFolder: string,
		fileRow?: boolean,
	) => void;
	handleDragEnd: () => void;
}

export function useDragDrop(
	onMove: (
		sourcePaths: string[],
		targetFolder: string,
	) => Promise<void>,
	onExpandFolder: (path: string) => void,
	getWorkspacePath?: (path: string) => string | undefined,
	onImport?: (
		files: File[],
		folderNames: string[],
		targetFolder: string,
	) => void,
): UseDragDropReturn {
	const [draggedPaths, setDraggedPaths] = useState<
		string[] | null
	>(null);
	const [dropTargetPath, setDropTargetPath] = useState<
		string | null
	>(null);
	const [externalTargetFolder, setExternalTargetFolder] = useState<
		string | null
	>(null);
	const expandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);
	const draggedPathsRef = useRef<string[] | null>(null);
	const dragSourceWorkspaceRef = useRef<string | undefined>(undefined);

	const clearExpandTimer = useCallback(() => {
		if (expandTimerRef.current) {
			clearTimeout(expandTimerRef.current);
			expandTimerRef.current = null;
		}
	}, []);

	const handleDragStart = useCallback(
		(
			e: React.DragEvent,
			path: string,
			selectedPaths: Set<string>,
		) => {
			const paths = selectedPaths.has(path)
				? [...selectedPaths]
				: [path];
			draggedPathsRef.current = paths;
			dragSourceWorkspaceRef.current =
				getWorkspacePath?.(path);
			setDraggedPaths(paths);
			services.desktop.dragPaths.set(paths);
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData(
				'text/plain',
				paths.join('\n'),
			);

			// Clear drag signal on pointerup so the viewer
			// reverts immediately instead of waiting for the
			// browser's dragend snap-back animation.
			const onPointerUp = () => {
				services.desktop.dragPaths.clear();
				document.removeEventListener(
					'pointerup',
					onPointerUp,
				);
			};
			document.addEventListener(
				'pointerup',
				onPointerUp,
				{ once: true },
			);
		},
		[getWorkspacePath],
	);

	const handleDragOver = useCallback(
		(e: React.DragEvent, folderPath: string, fileRow?: boolean) => {
			const mode = classifyTreeDrag(
				draggedPathsRef.current,
				e.dataTransfer,
			);
			if (mode === 'external') {
				if (!onImport) return;
				e.preventDefault();
				e.dataTransfer.dropEffect = 'copy';
				if (dropTargetPath !== folderPath) {
					setDropTargetPath(folderPath);
					setExternalTargetFolder(folderPath);
					clearExpandTimer();
					expandTimerRef.current = setTimeout(() => {
						onExpandFolder(folderPath);
					}, 800);
				}
				return;
			}
			if (mode === 'none') return;
			// internal — a file row is not a move target; only external
			// mode resolves file rows to their parent, so internal
			// behavior is untouched by the file-row wiring.
			if (fileRow) return;

			const paths = draggedPathsRef.current;
			if (!paths) return;

			const sourceWs = dragSourceWorkspaceRef.current;
			if (
				sourceWs &&
				getWorkspacePath &&
				getWorkspacePath(folderPath) !== sourceWs
			) {
				e.dataTransfer.dropEffect = 'none';
				return;
			}

			const isInvalid = paths.some(
				(p) =>
					p === folderPath ||
					folderPath.startsWith(p + '/'),
			);
			if (isInvalid) {
				e.dataTransfer.dropEffect = 'none';
				return;
			}

			e.preventDefault();
			e.dataTransfer.dropEffect = 'move';

			if (dropTargetPath !== folderPath) {
				setDropTargetPath(folderPath);
				clearExpandTimer();
				expandTimerRef.current = setTimeout(() => {
					onExpandFolder(folderPath);
				}, 800);
			}
		},
		[
			dropTargetPath,
			clearExpandTimer,
			onExpandFolder,
			getWorkspacePath,
			onImport,
		],
	);

	const handleDragLeave = useCallback(() => {
		setDropTargetPath(null);
		setExternalTargetFolder(null);
		clearExpandTimer();
	}, [clearExpandTimer]);

	const handleDrop = useCallback(
		(e: React.DragEvent, targetFolder: string, fileRow?: boolean) => {
			// Rows own their destination; don't also import into the host's empty-area target.
			e.stopPropagation();
			const mode = classifyTreeDrag(
				draggedPathsRef.current,
				e.dataTransfer,
			);
			if (mode === 'external') {
				if (!onImport) return;
				e.preventDefault();
				clearExpandTimer();
				setDropTargetPath(null);
				setExternalTargetFolder(null);
				// Synchronous, before any await — a DataTransfer is
				// emptied once the event finishes dispatching (see
				// ../Terminal/file-drop).
				const { files, folderNames } = dropContents(
					e.dataTransfer,
				);
				if (files.length === 0 && folderNames.length === 0)
					return;
				onImport(files, folderNames, targetFolder);
				return;
			}
			if (mode === 'none') return;
			if (fileRow) return;

			e.preventDefault();
			clearExpandTimer();
			setDropTargetPath(null);

			const paths = draggedPathsRef.current;
			if (!paths || paths.length === 0) return;

			const sourceWs = dragSourceWorkspaceRef.current;
			if (
				sourceWs &&
				getWorkspacePath &&
				getWorkspacePath(targetFolder) !== sourceWs
			) {
				return;
			}

			const isInvalid = paths.some(
				(p) =>
					p === targetFolder ||
					targetFolder.startsWith(p + '/'),
			);
			if (isInvalid) return;

			void onMove(paths, targetFolder);
			services.desktop.dragPaths.clear();
			setDraggedPaths(null);
			draggedPathsRef.current = null;
		},
		[clearExpandTimer, onMove, getWorkspacePath, onImport],
	);

	const handleDragEnd = useCallback(() => {
		setDraggedPaths(null);
		services.desktop.dragPaths.clear();
		draggedPathsRef.current = null;
		dragSourceWorkspaceRef.current = undefined;
		setDropTargetPath(null);
		setExternalTargetFolder(null);
		clearExpandTimer();
	}, [clearExpandTimer]);

	return {
		draggedPaths,
		dropTargetPath,
		externalTargetFolder,
		handleDragStart,
		handleDragOver,
		handleDragLeave,
		handleDrop,
		handleDragEnd,
	};
}
