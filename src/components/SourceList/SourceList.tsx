// Adapted from packages/components/src/SourceList/SourceList.tsx at 600e05f2294df5c71026b723915306a74c8cfd3a.
import type { ItemSource, SourceItem } from "@builder/shared/viewer-types";
import { ExcerptDisplay } from "@builder/components/ExcerptDisplay";
import { Markdown } from "@builder/components/Markdown";
import { ConceptList } from "@builder/components/ConceptList";

interface SourceItemComponentProps {
  item: SourceItem;
  highlightText?: string | undefined;
}

function SourceItemComponent({
  item,
  highlightText,
}: SourceItemComponentProps) {
  const hasExcerpts = item.excerpts && item.excerpts.length > 0;
  const hasConcepts = item.relatedConcepts && item.relatedConcepts.length > 0;

  return (
    <div className="source-item">
      {item.type && (
        <div className="item-metadata">
          <div
            className={`item-type-badge ${item.type.toLowerCase()}`}
            style={{ marginBottom: 0 }}
          >
            {item.type}
          </div>
          {item.modifiedAt && (
            <div className="metadata-item">
              <div className="metadata-label">Modified</div>
              <div className="metadata-value">
                {new Date(item.modifiedAt).toLocaleDateString()}
              </div>
            </div>
          )}
        </div>
      )}

      <h3 className="source-item-name clickable">{item.title}</h3>

      {item.text && (
        <Markdown
          className="source-item-text"
          content={item.text}
          enableKatex={item.type.toLowerCase() === "pdf"}
        />
      )}

      {hasExcerpts && (
        <ExcerptDisplay
          excerpts={item.excerpts!}
          highlightText={highlightText}
        />
      )}

      {hasConcepts && (
        <ConceptList
          concepts={item.relatedConcepts!}
          label="Related Concepts"
        />
      )}
    </div>
  );
}

interface SourceProps {
  sourceName: string;
  items: SourceItem[];
  highlightText?: string | undefined;
}

function Source({ sourceName, items, highlightText }: SourceProps) {
  return (
    <div className="source-items-card">
      <h4 className="section-label">{sourceName}</h4>

      {items && items.length > 0 ? (
        <div className="source-items-list">
          {items.map((item) => (
            <SourceItemComponent
              key={item.id}
              item={item}
              highlightText={highlightText}
            />
          ))}
        </div>
      ) : (
        <div style={{ textAlign: "center", padding: "32px 16px", color: "var(--color-text-secondary)" }}>
          No items in this source
        </div>
      )}
    </div>
  );
}

interface SourceListProps {
  sources: ItemSource[];
  highlightText?: string | undefined;
}

export function SourceList({ sources, highlightText }: SourceListProps) {
  if (!sources || sources.length === 0) return null;

  return (
    <>
      {sources.map((source, sourceIndex) =>
        Object.entries(source).map(([sourceName, items]) =>
          Array.isArray(items) ? (
            <Source
              key={`${sourceIndex}-${sourceName}`}
              sourceName={sourceName}
              items={items}
              highlightText={highlightText}
            />
          ) : null,
        ),
      )}
    </>
  );
}
