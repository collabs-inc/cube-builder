// Adapted from packages/shared/src/types.ts at 600e05f2294df5c71026b723915306a74c8cfd3a.
export interface WriteResult {
  ok: boolean;
  mtime: string;
  conflict?: boolean;
}

/**
 * One entry from a directory listing — main/files.ts's fsReadDir and the
 * daemon's directory listing op both return these, and filterDirEntries
 * applies the workspace ignore rules to them before the renderer sees them.
 * `fileCount` is only ever set on a directory entry, after filtering.
 */
export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
  createdAt: string;
  modifiedAt: string;
  fileCount?: number;
}

export interface ViewerItem {
  id: string;
  title: string;
  type: string;
  isEditable: boolean;
  isTitleEditable?: boolean;
  url?: string;
  fileUrl?: string;
  summary?: string;
  quotes?: Quote[];
  quotesTitle?: string;
  text?: string;
  rawContext?: string;
  createdAt: number;
  modifiedAt: number;
  relatedConcepts?: Concept[];
  sources?: ItemSource[];
  isPinned?: boolean;
  cube_reviewed?: boolean;
  frontmatter?: Record<string, unknown>;
}

export interface Quote {
  text: string;
}

export interface ItemSource {
  [sourceName: string]: SourceItem[];
}

export interface SourceItem {
  id: string;
  title: string;
  type: string;
  author?: string;
  url?: string;
  urlThumbnail?: string;
  summary?: string;
  text?: string;
  excerpts?: string[];
  relatedConcepts?: Concept[];
  modifiedAt?: number;
}

export interface Concept {
  id: string;
  title: string;
  similarityScore?: string;
  degree?: number;
}

