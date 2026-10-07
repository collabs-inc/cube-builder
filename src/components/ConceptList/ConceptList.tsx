// Adapted from packages/components/src/ConceptList/ConceptList.tsx at 600e05f2294df5c71026b723915306a74c8cfd3a.
import type { Concept } from "@builder/shared/viewer-types";

function ConceptComponent({ concept }: { concept: Concept }) {
  const formattedScore = concept.similarityScore
    ? (parseFloat(concept.similarityScore) * 100).toFixed(0)
    : null;

  const formattedDegree =
    concept.degree !== undefined && concept.degree > 0
      ? `\u00B0${concept.degree}`
      : null;

  let tooltipText = concept.title;
  if (formattedScore) tooltipText += ` - Similarity: ${formattedScore}%`;
  if (formattedDegree)
    tooltipText += ` - Degree: ${concept.degree} connections`;

  return (
    <span className="concept-item" title={tooltipText}>
      {concept.title}
      {formattedScore && (
        <span className="concept-score">{formattedScore}%</span>
      )}
      {formattedDegree && (
        <span className="concept-score">{formattedDegree}</span>
      )}
    </span>
  );
}

interface ConceptListProps {
  concepts: Concept[];
  label?: string;
}

export function ConceptList({
  concepts,
  label = "Concepts",
}: ConceptListProps) {
  if (!concepts || concepts.length === 0) return null;

  const sortedConcepts = [...concepts].sort((a, b) => {
    const degreeA = a.degree ?? 0;
    const degreeB = b.degree ?? 0;
    if (degreeA !== degreeB) return degreeB - degreeA;

    const simA = a.similarityScore ? parseFloat(a.similarityScore) : 0;
    const simB = b.similarityScore ? parseFloat(b.similarityScore) : 0;
    if (simA !== simB) return simB - simA;

    return a.title.localeCompare(b.title);
  });

  return (
    <div className="concepts-container">
      <span className="section-label">{label}</span>
      <div className="concepts-list">
        {sortedConcepts.map((concept) => (
          <ConceptComponent key={concept.id} concept={concept} />
        ))}
      </div>
    </div>
  );
}
