// The pure half of the tree's external-file drop mode. useDragDrop calls
// these; they live apart so the mode logic is testable without a DOM.
import { carriesFiles } from '@port/shared/file-drag';
import { parentPath } from '@port/shared/path-utils';

/**
 * Every tree row resolves to the folder a drop would land in: a folder is
 * itself, the repo (workspace) row is the repo root, and a file resolves
 * to its parent — so nothing in a repo's subtree is a dead zone and the
 * highlight can follow where the file will actually land.
 */
export function resolveDropFolder(item: {
	kind: 'folder' | 'file' | 'workspace';
	path: string;
}): string {
	return item.kind === 'file' ? parentPath(item.path) : item.path;
}

/**
 * Which mode a drag over the tree is in. Internal wins outright: a drag
 * that started on a tree row is a move even if the DataTransfer also
 * reports files. 'none' (a text selection, a nav-internal drag from some
 * other surface) must leave the tree inert.
 */
export function classifyTreeDrag(
	internalPaths: string[] | null,
	dataTransfer: Parameters<typeof carriesFiles>[0],
): 'internal' | 'external' | 'none' {
	if (internalPaths !== null && internalPaths.length > 0) return 'internal';
	return carriesFiles(dataTransfer) ? 'external' : 'none';
}
