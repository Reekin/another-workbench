import { useEffect, useRef, type ReactElement } from "react";
import type { ComposerSuggestionState } from "./composer-types.js";

export const ComposerSuggestions = ({
  suggestions,
  onHover,
  onSelect
}: {
  suggestions: ComposerSuggestionState | undefined;
  onHover: (index: number) => void;
  onSelect: (index: number) => Promise<void>;
}): ReactElement | null => {
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!suggestions || suggestions.items.length === 0) {
      itemRefs.current = [];
      return;
    }
    const activeItem = itemRefs.current[suggestions.highlightedIndex];
    if (!activeItem) {
      return;
    }
    activeItem.scrollIntoView({
      block: "nearest"
    });
  }, [suggestions]);

  if (!suggestions) {
    return null;
  }

  return (
    <div className="awb-composer-suggestions" role="listbox">
      {suggestions.loading && suggestions.items.length === 0 ? (
        <div className="awb-composer-suggestions__empty">Loading…</div>
      ) : null}
      {!suggestions.loading && suggestions.items.length === 0 ? (
        <div className="awb-composer-suggestions__empty">No matches</div>
      ) : null}
      {suggestions.items.map((item, index) => (
        <button
          key={item.id}
          ref={(element) => {
            itemRefs.current[index] = element;
          }}
          type="button"
          className={`awb-composer-suggestions__item${
            suggestions.highlightedIndex === index ? " is-active" : ""
          }`}
          onMouseEnter={() => onHover(index)}
          onClick={() => void onSelect(index)}
        >
          <strong>{item.label}</strong>
          <span>{item.detail}</span>
        </button>
      ))}
    </div>
  );
};
