// Adapted from packages/components/src/ExcerptDisplay/ExcerptDisplay.tsx at 600e05f2294df5c71026b723915306a74c8cfd3a.
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeRaw from "rehype-raw";

interface ExcerptDisplayProps {
  excerpts: string[];
  highlightText?: string | undefined;
}

function pluralize(word: string): string {
  const lower = word.toLowerCase();
  if (/[sxz]$|[cs]h$/.test(lower)) return word + "es";
  if (/[bcdfghjklmnpqrstvwxz]y$/i.test(word))
    return word.slice(0, -1) + "ies";
  if (/f$/.test(lower)) return word.slice(0, -1) + "ves";
  if (/fe$/.test(lower)) return word.slice(0, -2) + "ves";
  return word + "s";
}

function singularize(word: string): string {
  if (/ies$/i.test(word)) return word.slice(0, -3) + "y";
  if (/ves$/i.test(word)) return word.slice(0, -3) + "f";
  if (/[sxz]es$|[cs]hes$/i.test(word)) return word.slice(0, -2);
  if (/s$/i.test(word) && word.length > 1) return word.slice(0, -1);
  return word;
}

function getSingularPluralForms(word: string): string[] {
  const forms = [word];
  if (/s$/i.test(word) && word.length > 1) {
    const singular = singularize(word);
    if (singular !== word) forms.push(singular);
  }
  const plural = pluralize(word);
  if (plural !== word) forms.push(plural);
  return forms;
}

function highlightTextInExcerpt(text: string, highlightText: string): string {
  if (!highlightText || !text) return text;

  const forms = getSingularPluralForms(highlightText);
  const escapedForms = forms.map((form) =>
    form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  const pattern = escapedForms.join("|");
  const regex = new RegExp(`(${pattern})`, "gi");

  const matches: Array<{ start: number; end: number; text: string }> = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    matches.push({
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
    });
  }

  let result = text;
  for (let i = matches.length - 1; i >= 0; i--) {
    const { start, end, text: matchText } = matches[i]!;
    const beforeMatch = result.substring(Math.max(0, start - 40), start);
    const afterMatch = result.substring(
      end,
      Math.min(result.length, end + 7),
    );

    if (
      beforeMatch.includes('<span class="excerpt-highlight">') &&
      afterMatch.includes("</span>")
    ) {
      continue;
    }

    result =
      result.substring(0, start) +
      `<span class="excerpt-highlight">${matchText}</span>` +
      result.substring(end);
  }

  return result;
}

export function ExcerptDisplay({
  excerpts,
  highlightText,
}: ExcerptDisplayProps) {
  if (!excerpts || excerpts.length === 0) return null;

  return (
    <div className="excerpts-container">
      {excerpts.map((excerpt, index) => {
        const highlighted = highlightText
          ? highlightTextInExcerpt(excerpt, highlightText)
          : excerpt;
        return (
          <div key={index} className="excerpt-item markdown-content">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkBreaks]}
              rehypePlugins={[rehypeRaw]}
            >
              {highlighted}
            </ReactMarkdown>
          </div>
        );
      })}
    </div>
  );
}
