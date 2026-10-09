import { services } from "../../renderer/services";
import React, {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from 'react';
import type { TreeNode } from '@port/shared/types';
import {
	useWorkspaceFileTree,
} from './useWorkspaceFileTree';
import type { WorkspaceFileTreeHandle } from './useWorkspaceFileTree';
import type { FlatItem } from './useFileTree';
import type { SortMode } from './types';
import { getDateKey, formatDateLabel } from './Helpers';
import { TreeView } from './TreeView';
import { FolderRow } from './TreeView';
import { treeErrorMessage } from './treeError';
import { LoadingPulse } from '../LoadingPulse';

export interface WorkspaceTreeProps {
	workspace: { path: string; name: string };
	isExpanded: boolean;
	onToggleExpand: (
		path: string,
		recursive: boolean,
	) => void;
	selectedPath: string | null;
	selectedPaths: Set<string>;
	onItemClick: (
		path: string,
		e: { metaKey: boolean; shiftKey: boolean },
	) => void;
	onCreateFile: (
		folderPath: string,
		name: string,
	) => void;
	onPlusClick?: ((folderPath: string) => void) | undefined;
	onDeleteFile?: ((path: string) => void) | undefined;
	onContextMenu?: ((
		e: React.MouseEvent,
		item: FlatItem | null,
	) => void) | undefined;
	sortMode: SortMode;
	renamingPath?: string | null | undefined;
	renameValue?: string | undefined;
	renameInputRef?: React.RefObject<HTMLInputElement | null> | undefined;
	onRenameChange?: ((value: string) => void) | undefined;
	onRenameConfirm?: (() => void) | undefined;
	onRenameCancel?: (() => void) | undefined;
	onDragStart?: ((
		e: React.DragEvent,
		path: string,
	) => void) | undefined;
	onDragOver?: ((
		e: React.DragEvent,
		folderPath: string,
		fileRow?: boolean,
	) => void) | undefined;
	onDragLeave?: (() => void) | undefined;
	onDrop?: ((
		e: React.DragEvent,
		targetFolder: string,
		fileRow?: boolean,
	) => void) | undefined;
	onDragEnd?: (() => void) | undefined;
	dropTargetPath?: string | null | undefined;
	onSelectFolder?: ((path: string) => void) | undefined;
	isFirstWorkspace?: boolean | undefined;
	searchQuery?: string | undefined;
	listView?: boolean | undefined;
	initialExpandAll?: boolean | undefined;
	onExpandAllComplete?: ((wsPath: string) => void) | undefined;
}

function flattenAllFiles(
	nodes: TreeNode[],
	workspacePath: string,
): FlatItem[] {
	const items: FlatItem[] = [];
	const prefix = workspacePath.replace(/[\\/]+$/, '').length + 1;
	function walk(children: TreeNode[]) {
		for (const node of children) {
			if (node.kind === 'file') {
				items.push({
					id: node.path,
					kind: 'file',
					level: 1,
					name: node.path.slice(prefix),
					path: node.path,
					ctime: node.ctime,
					mtime: node.mtime,
					workspacePath,
				});
			}
			if (node.children) {
				walk(node.children);
			}
		}
	}
	walk(nodes);
	return items;
}

export const WorkspaceTree = forwardRef<
	WorkspaceFileTreeHandle,
	WorkspaceTreeProps
>(function WorkspaceTree(
	{
		workspace,
		isExpanded,
		onToggleExpand,
		selectedPath,
		selectedPaths,
		onItemClick,
		onCreateFile,
		onPlusClick,
		onDeleteFile,
		onContextMenu,
		sortMode,
		renamingPath,
		renameValue,
		renameInputRef,
		onRenameChange,
		onRenameConfirm,
		onRenameCancel,
		onDragStart,
		onDragOver,
		onDragLeave,
		onDrop,
		onDragEnd,
		dropTargetPath,
		onSelectFolder,
		isFirstWorkspace = false,
		searchQuery,
		listView = false,
		initialExpandAll = false,
		onExpandAllComplete,
	},
	ref,
) {
	const {
		flatItems,
		rootError,
		rootLoading,
		toggleExpand: toggleDirExpand,
		expandFolder,
		expandAncestors,
		expandRecursive,
		collapseAllDirs,
		navigableItems,
	} = useWorkspaceFileTree(
		workspace.path,
		sortMode,
	);

	// Handle initialExpandAll on mount
	useEffect(() => {
		if (initialExpandAll) {
			expandRecursive(workspace.path);
			onExpandAllComplete?.(workspace.path);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- only on mount when flag is set
	}, [initialExpandAll]);

	// Per-workspace search
	const [allFiles, setAllFiles] = useState<
		FlatItem[] | null
	>(null);
	/**
	 * The whole-tree walk's own failure — the search/list view's counterpart
	 * to the hook's rootError, and set from the same place a rejection would
	 * otherwise have gone nowhere at all. Without it a refused walk (an old
	 * daemon that cannot list files) reads as a repo with no files in it.
	 */
	const [treeError, setTreeError] = useState<
		string | null
	>(null);
	const isSearching =
		(searchQuery ?? '').trim().length > 0;
	const needsAllFiles = isSearching || listView;
	const fetchVersion = useRef(0);
	const [fetchTrigger, setFetchTrigger] = useState(0);

	// Trigger re-fetch (without nulling allFiles) when FS changes
	useEffect(() => {
		if (needsAllFiles) {
			fetchVersion.current += 1;
			setFetchTrigger(fetchVersion.current);
		}
	// eslint-disable-next-line react-hooks/exhaustive-deps -- flatItems ref changes on any FS update
	}, [flatItems]);

	useEffect(() => {
		if (!needsAllFiles) {
			setAllFiles(null);
			setTreeError(null);
			return;
		}
		let cancelled = false;
		services.files.readTree({ root: workspace.path })
			.then((tree: TreeNode[]) => {
				if (cancelled) return;
				setTreeError(null);
				setAllFiles(
					flattenAllFiles(
						tree,
						workspace.path,
					),
				);
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setTreeError(treeErrorMessage(err));
			});
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- fetchTrigger drives re-fetch on FS changes
	}, [needsAllFiles, workspace.path, fetchTrigger]);

	const filteredItems = useMemo(() => {
		if (!searchQuery?.trim() && !listView) return flatItems;
		// While allFiles is loading, keep showing the tree view
		if (listView && !allFiles && !searchQuery?.trim()) return flatItems;
		const source = allFiles ?? flatItems;
		let items: FlatItem[];
		if (listView && !searchQuery?.trim()) {
			items = source.filter((item) => item.kind !== 'folder');
		} else {
			const query = searchQuery!.toLowerCase();
			items = source.filter((item) => {
				if (item.kind === 'folder') return false;
				const name = item.name.toLowerCase();
				const slash = name.lastIndexOf('/');
				const fileName =
					slash >= 0
						? name.slice(slash + 1)
						: name;
				return fileName.includes(query);
			});
		}
		// Sort by current sortMode
		const toTime = (v?: string | number): number =>
			typeof v === 'number' ? v : v ? new Date(v).getTime() : 0;
		const basename = (n: string) => {
			const i = n.lastIndexOf('/');
			return i >= 0 ? n.slice(i + 1) : n;
		};
		const cmp = (a: FlatItem, b: FlatItem) => {
			switch (sortMode) {
				case 'alpha-asc':
					return basename(a.name).localeCompare(basename(b.name));
				case 'alpha-desc':
					return basename(b.name).localeCompare(basename(a.name));
				case 'created-desc':
					return toTime(b.ctime) - toTime(a.ctime);
				case 'created-asc':
					return toTime(a.ctime) - toTime(b.ctime);
				case 'modified-desc':
					return toTime(b.mtime) - toTime(a.mtime);
				case 'modified-asc':
					return toTime(a.mtime) - toTime(b.mtime);
				default:
					return 0;
			}
		};
		return items.sort(cmp);
	}, [flatItems, allFiles, searchQuery, listView, sortMode]);

	useImperativeHandle(
		ref,
		() => ({
			flatItems,
			navigableItems:
				(isSearching || listView) ? filteredItems : navigableItems,
			expandAncestors,
			expandRecursive,
			collapseAllDirs,
		}),
		[
			flatItems,
			navigableItems,
			isSearching,
			listView,
			filteredItems,
			expandAncestors,
			expandRecursive,
			collapseAllDirs,
		],
	);

	// Group flat items by date or alphabetical initial
	const groupedFlatItems = useMemo(() => {
		if (!listView || isSearching || !allFiles) return null;
		const groups: { key: string; label: string; items: FlatItem[] }[] = [];
		const map = new Map<string, { key: string; label: string; items: FlatItem[] }>();

		if (sortMode.startsWith('alpha')) {
			for (const item of filteredItems) {
				const letter = (item.name.split('/').pop()?.[0] ?? '#').toUpperCase();
				const existing = map.get(letter);
				if (existing) {
					existing.items.push(item);
				} else {
					const group = { key: letter, label: letter, items: [item] };
					map.set(letter, group);
					groups.push(group);
				}
			}
		} else {
			const dateField = sortMode.startsWith('modified') ? 'mtime' : 'ctime';
			for (const item of filteredItems) {
				const ts = item[dateField];
				const tsStr = typeof ts === 'number' ? new Date(ts).toISOString() : (ts ?? '');
				const key = getDateKey(tsStr);
				const existing = map.get(key);
				if (existing) {
					existing.items.push(item);
				} else {
					const group = { key, label: formatDateLabel(tsStr), items: [item] };
					map.set(key, group);
					groups.push(group);
				}
			}
		}

		return groups;
	}, [listView, isSearching, filteredItems, sortMode]);

	const workspaceItem: FlatItem = useMemo(
		() => ({
			id: `ws:${workspace.path}`,
			kind: 'workspace',
			level: 0,
			name: workspace.name,
			path: workspace.path,
			isExpanded,
		}),
		[workspace.path, workspace.name, isExpanded],
	);

	/** The root listing's failure wins: the search walk's is a consequence of it. */
	const listingError = rootError ?? treeError;

	const handleToggleFolder = useCallback(
		(path: string, recursive: boolean) => {
			toggleDirExpand(path, recursive);
		},
		[toggleDirExpand],
	);

	if (rootLoading && isExpanded) {
		return <LoadingPulse label="Loading file tree" />;
	}

	return (
		<div className={`workspace-group${isExpanded ? '' : ' collapsed'}`}>
			<FolderRow
				item={workspaceItem}
				onToggle={(path, recursive) =>
					onToggleExpand(path, recursive)
				}
				onCreateFile={onCreateFile}
				onPlusClick={onPlusClick}
				rowHeight={0}
				isRenaming={false}
				renameValue=""
				renameInputRef={{ current: null }}
				onRenameChange={() => {}}
				onRenameConfirm={() => {}}
				onRenameCancel={() => {}}
				onContextMenu={onContextMenu}
				isDropTarget={
					dropTargetPath === workspace.path
				}
				onDragOver={onDragOver}
				onDragLeave={onDragLeave}
				onDrop={onDrop}
				isWorkspace
				isFirstWorkspace={isFirstWorkspace}
				hideChevron={isSearching}
			/>
			{(isExpanded || (isSearching && filteredItems.length > 0)) && groupedFlatItems ? (
				groupedFlatItems.map((group) => (
					<div key={group.key}>
						<div className="list-date-separator">
							{group.label}
						</div>
						<TreeView
							flatItems={group.items}
							selectedPath={selectedPath}
							selectedPaths={selectedPaths}
							onItemClick={onItemClick}
							onToggleFolder={handleToggleFolder}
							onCreateFile={onCreateFile}
							onPlusClick={onPlusClick}
							onContextMenu={onContextMenu}
							onDeleteFile={onDeleteFile}
							sortMode={sortMode}
							onCycleSortMode={() => {}}
							renamingPath={renamingPath}
							renameValue={renameValue}
							renameInputRef={renameInputRef}
							onRenameChange={onRenameChange}
							onRenameConfirm={onRenameConfirm}
							onRenameCancel={onRenameCancel}
							dropTargetPath={dropTargetPath}
							onDragStart={onDragStart}
							onDragOver={onDragOver}
							onDragLeave={onDragLeave}
							onDrop={onDrop}
							onDragEnd={onDragEnd}
							workspacePath={workspace.path}
							onSelectFolder={onSelectFolder}
							searchQuery={searchQuery}
						/>
					</div>
				))
			) : (isExpanded || (isSearching && filteredItems.length > 0)) ? (
				<TreeView
					flatItems={filteredItems}
					selectedPath={selectedPath}
					selectedPaths={selectedPaths}
					onItemClick={onItemClick}
					onToggleFolder={
						handleToggleFolder
					}
					onCreateFile={onCreateFile}
					onPlusClick={onPlusClick}
					onContextMenu={onContextMenu}
					onDeleteFile={onDeleteFile}
					sortMode={sortMode}
					onCycleSortMode={() => {}}
					renamingPath={renamingPath}
					renameValue={renameValue}
					renameInputRef={renameInputRef}
					onRenameChange={onRenameChange}
					onRenameConfirm={onRenameConfirm}
					onRenameCancel={onRenameCancel}
					dropTargetPath={dropTargetPath}
					onDragStart={onDragStart}
					onDragOver={onDragOver}
					onDragLeave={onDragLeave}
					onDrop={onDrop}
					onDragEnd={onDragEnd}
					workspacePath={workspace.path}
					onSelectFolder={onSelectFolder}
					searchQuery={searchQuery}
				/>
			) : null}
			{/* An unlistable workspace is not an empty one — say which. */}
			{(isExpanded || isSearching) && listingError && (
				<div className="tree-root-error">
					{listingError}
				</div>
			)}
			{(isExpanded || isSearching) &&
				!listingError &&
				filteredItems.length === 0 && (
					<div className="search-no-matches">
						No matching files
					</div>
				)}
		</div>
	);
});
