import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * A real combobox for the model id: opens its option list on focus/click,
 * filters as you type (space-separated terms all must match, case-insensitive,
 * so "qwen 9b" finds Qwen3.5-9B-OptiQ-4bit), supports arrow-key navigation,
 * and still accepts free text for endpoints that are offline. Replaces a
 * native <datalist>, whose dropdown quirks made it look broken.
 */
export function ModelCombobox({
  value,
  models,
  tags,
  placeholder,
  onChange,
  onOpen
}: {
  value: string;
  models: string[];
  /** Optional right-aligned tag per model id (e.g. "vision" for VLMs). */
  tags?: Record<string, string | undefined>;
  placeholder?: string;
  onChange: (nextValue: string) => void;
  /** Called when the dropdown opens — used to refresh the model list. */
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const filteredModels = useMemo(() => {
    const query = value.trim().toLowerCase();
    // An exact selection filters to itself, which would hide the alternatives
    // right when the user wants to switch — show everything instead.
    if (!query || models.some((model) => model.toLowerCase() === query)) return models;
    const terms = query.split(/\s+/);
    return models.filter((model) => {
      const candidate = model.toLowerCase();
      return terms.every((term) => candidate.includes(term));
    });
  }, [models, value]);

  useEffect(() => {
    setHighlightIndex((previous) => Math.min(previous, Math.max(filteredModels.length - 1, 0)));
  }, [filteredModels.length]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function openList() {
    if (!open) {
      onOpen?.();
      setOpen(true);
      setHighlightIndex(0);
    }
  }

  function select(model: string) {
    onChange(model);
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openList();
        return;
      }
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const count = Math.max(filteredModels.length, 1);
      setHighlightIndex((previous) => (previous + direction + count) % count);
      return;
    }
    if (event.key === "Enter" && open && filteredModels[highlightIndex] !== undefined) {
      event.preventDefault();
      select(filteredModels[highlightIndex]);
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div className="model-combobox" ref={containerRef}>
      <input
        aria-autocomplete="list"
        aria-expanded={open}
        aria-label="Model"
        placeholder={placeholder}
        role="combobox"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          openList();
          setOpen(true);
        }}
        onClick={openList}
        onFocus={openList}
        onKeyDown={onKeyDown}
      />
      <button
        aria-label={open ? "Hide model suggestions" : "Show model suggestions"}
        className="model-combobox-toggle"
        tabIndex={-1}
        type="button"
        onPointerDown={(event) => {
          event.preventDefault();
          if (open) setOpen(false);
          else openList();
        }}
      >
        <ChevronDown size={14} />
      </button>
      {open ? (
        <ul className="model-combobox-list" role="listbox">
          {filteredModels.length ? (
            filteredModels.map((model, index) => (
              <li
                aria-selected={model === value}
                className={index === highlightIndex ? "highlighted" : undefined}
                key={model}
                role="option"
                onMouseEnter={() => setHighlightIndex(index)}
                onPointerDown={(event) => {
                  // pointerdown, not click: selecting must beat the input blur.
                  event.preventDefault();
                  select(model);
                }}
              >
                <span>{model}</span>
                {tags?.[model] ? <em className="model-combobox-tag">{tags[model]}</em> : null}
              </li>
            ))
          ) : (
            <li className="model-combobox-empty">
              {models.length
                ? "No models match — free text is fine."
                : "No models listed (endpoint unreachable?) — type the id."}
            </li>
          )}
        </ul>
      ) : null}
    </div>
  );
}
