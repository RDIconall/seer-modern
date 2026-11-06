"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import type { MatterCard } from "@/lib/v2/view/types";
import type { StaffTask } from "@/lib/v2/staff/types";
import {
  domainForMatter,
  domainForTask,
  isDueSoon,
} from "@/lib/v2/whiteboard/domains";
import type {
  WhiteboardItem,
  WhiteboardSection,
  WhiteboardView,
} from "@/lib/v2/whiteboard/types";

const RELATED_MATTERS = 4;

function itemsForSection(
  section: WhiteboardSection,
  all: WhiteboardItem[],
  now: number,
): WhiteboardItem[] {
  if (section.slug === "done") {
    return all.filter(
      (item) => item.status === "done" || item.sectionSlug === "done",
    );
  }
  const own = section.items.filter((item) => item.status === "open");
  if (section.slug === "due-now") {
    const soon = all.filter(
      (item) =>
        item.status === "open" &&
        item.sectionSlug !== "due-now" &&
        isDueSoon(item.dueAt, now),
    );
    return [...own, ...soon];
  }
  return own;
}

export function CeoWhiteboard({
  view,
  matters,
  tasks,
  currentConversationId,
  selectedItemId,
  selectedMatterId,
  onOpenItem,
  onToggleItem,
  onCreateItem,
  onOpenMatter,
  onOpenTask,
}: {
  view: WhiteboardView;
  matters: MatterCard[];
  tasks: StaffTask[];
  currentConversationId?: string | null;
  selectedItemId?: string | null;
  selectedMatterId?: string | null;
  onOpenItem?: (item: WhiteboardItem) => void;
  onToggleItem?: (item: WhiteboardItem, done: boolean) => void;
  onCreateItem?: (sectionSlug: string, title: string) => void;
  onOpenMatter?: (matter: MatterCard) => void;
  onOpenTask?: (taskId: string, conversationId?: string | null) => void;
}) {
  const now = Date.now();
  const allItems = useMemo(
    () => view.sections.flatMap((section) => section.items),
    [view.sections],
  );
  const mattersByDomain = useMemo(() => {
    const map = new Map<string, MatterCard[]>();
    for (const matter of matters) {
      const slug = domainForMatter(matter);
      if (!slug) continue;
      const list = map.get(slug) ?? [];
      list.push(matter);
      map.set(slug, list);
    }
    return map;
  }, [matters]);
  const tasksByDomain = useMemo(() => {
    const map = new Map<string, StaffTask[]>();
    for (const task of tasks) {
      if (task.status === "done" || task.status === "dropped") continue;
      const slug = domainForTask(task);
      if (!slug) continue;
      const list = map.get(slug) ?? [];
      list.push(task);
      map.set(slug, list);
    }
    return map;
  }, [tasks]);

  const focusedSlug = useMemo(() => {
    if (selectedItemId) {
      const item = allItems.find((row) => row.id === selectedItemId);
      if (item) return item.sectionSlug;
    }
    if (selectedMatterId) {
      const matter = matters.find((row) => row.matterId === selectedMatterId);
      if (matter) return domainForMatter(matter);
    }
    if (currentConversationId) {
      const matter = matters.find((row) =>
        row.conversations.some(
          (conversation) => conversation.conversationId === currentConversationId,
        ),
      );
      if (matter) return domainForMatter(matter);
    }
    return null;
  }, [allItems, currentConversationId, matters, selectedItemId, selectedMatterId]);

  const sections = useMemo(() => {
    if (!focusedSlug) return view.sections;
    return [...view.sections].sort((a, b) => {
      if (a.slug === focusedSlug) return -1;
      if (b.slug === focusedSlug) return 1;
      return 0;
    });
  }, [focusedSlug, view.sections]);

  return (
    <div className="ceo-board" data-ceo-board="true">
      <div className="wb-columns ceo-columns">
        {sections.map((section) => {
          const items = itemsForSection(section, allItems, now);
          const related = mattersByDomain.get(section.slug) ?? [];
          const botWork = tasksByDomain.get(section.slug) ?? [];
          if (
            items.length === 0 &&
            related.length === 0 &&
            botWork.length === 0 &&
            section.slug === "done"
          ) {
            return null;
          }
          return (
            <section
              key={section.id}
              className={`wb-column ceo-box${
                section.slug === "due-now" ? " ceo-box-now" : ""
              }`}
              data-atlas-section={section.slug}
              data-ceo-section={section.slug}
            >
              <div className="wb-shead">
                <span className="wb-sname atlas-heading">{section.title}</span>
                <span className="wb-scount tabular">
                  {items.length}
                  {section.subtitle ? ` · ${section.subtitle}` : ""}
                </span>
              </div>
              <div className="wb-sec">
                {items.map((item) => (
                  <WhiteboardRow
                    key={item.id}
                    item={item}
                    current={
                      selectedItemId === item.id ||
                      (item.conversationId != null &&
                        item.conversationId === currentConversationId)
                    }
                    onOpen={() => onOpenItem?.(item)}
                    onToggle={(done) => onToggleItem?.(item, done)}
                  />
                ))}
                {related.length > 0 ? (
                  <RelatedMatters
                    matters={related}
                    currentConversationId={currentConversationId}
                    selectedMatterId={selectedMatterId}
                    onOpenMatter={onOpenMatter}
                  />
                ) : null}
                {botWork.length > 0 ? (
                  <RelatedBots tasks={botWork} onOpenTask={onOpenTask} />
                ) : null}
                {section.slug !== "done" && onCreateItem ? (
                  <AddItem
                    slug={section.slug}
                    title={section.title}
                    onCreate={onCreateItem}
                  />
                ) : null}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function WhiteboardRow({
  item,
  current,
  onOpen,
  onToggle,
}: {
  item: WhiteboardItem;
  current: boolean;
  onOpen: () => void;
  onToggle: (done: boolean) => void;
}) {
  const done = item.status === "done";
  return (
    <div
      className={`wb-m ceo-item${current ? " wb-m-current" : ""}${
        done ? " ceo-item-done" : ""
      }`}
      data-atlas-item={item.id}
      data-current={current ? "true" : undefined}
    >
      <label className="ceo-check">
        <input
          type="checkbox"
          checked={done}
          onChange={(event) => onToggle(event.target.checked)}
          aria-label={done ? `Reopen ${item.title}` : `Check off ${item.title}`}
        />
      </label>
      <button
        type="button"
        className="wb-mhead ceo-item-head"
        aria-label={
          item.conversationId
            ? `Open email for ${item.title}`
            : `Select ${item.title}`
        }
        onClick={onOpen}
      >
        <span className="wb-mt">{item.title}</span>
        <span className="wb-own tabular">{item.ownerLabel || "You"}</span>
        <span className="wb-age tabular">
          {item.conversationId ? "mail" : ""}
        </span>
      </button>
    </div>
  );
}

function RelatedMatters({
  matters,
  currentConversationId,
  selectedMatterId,
  onOpenMatter,
}: {
  matters: MatterCard[];
  currentConversationId?: string | null;
  selectedMatterId?: string | null;
  onOpenMatter?: (matter: MatterCard) => void;
}) {
  const shown = matters.slice(0, RELATED_MATTERS);
  const extra = matters.length - shown.length;
  return (
    <div className="ceo-related" aria-label="Mail on this domain">
      <span className="ceo-related-kicker tabular">Mail</span>
      {shown.map((matter) => {
        const current =
          selectedMatterId === matter.matterId ||
          matter.conversations.some(
            (conversation) =>
              conversation.conversationId === currentConversationId,
          );
        return (
          <button
            key={matter.matterId}
            type="button"
            className={`wb-mhead ceo-related-row${
              current ? " wb-m-current" : ""
            }`}
            data-atlas-matter={matter.matterId}
            aria-label={`Open latest email for ${matter.shortTitle}`}
            onClick={() => onOpenMatter?.(matter)}
          >
            <span className="wb-mt">{matter.shortTitle}</span>
          </button>
        );
      })}
      {extra > 0 ? (
        <span className="ceo-related-more tabular">{extra} more on Mail</span>
      ) : null}
    </div>
  );
}

function RelatedBots({
  tasks,
  onOpenTask,
}: {
  tasks: StaffTask[];
  onOpenTask?: (taskId: string, conversationId?: string | null) => void;
}) {
  const waiting = tasks.filter((task) => task.status === "waiting_on_user");
  const shown = waiting.length > 0 ? waiting.slice(0, 3) : tasks.slice(0, 2);
  return (
    <div className="ceo-related" aria-label="Bot work on this domain">
      <span className="ceo-related-kicker tabular">
        Bots · {tasks.length}
        {waiting.length > 0 ? ` · ${waiting.length} waiting` : ""}
      </span>
      {shown.map((task) => (
        <button
          key={task.id}
          type="button"
          className="wb-mhead ceo-related-row"
          data-atlas-task={task.id}
          aria-label={`Open delegated task ${task.title}`}
          onClick={() => onOpenTask?.(task.id, task.conversationId)}
        >
          <span className="wb-mt">{task.title}</span>
        </button>
      ))}
    </div>
  );
}

function AddItem({
  slug,
  title,
  onCreate,
}: {
  slug: string;
  title: string;
  onCreate: (sectionSlug: string, title: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <form
      className="ceo-add"
      onSubmit={(event) => {
        event.preventDefault();
        const next = value.trim();
        if (!next) return;
        onCreate(slug, next);
        setValue("");
      }}
    >
      <label className="ceo-add-label">
        <span className="sr-only">Add to {title}</span>
        <input
          className="staff-input ceo-add-input"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={`Add to ${title}`}
        />
      </label>
      <button type="submit" className="wb-btn">
        Add
      </button>
    </form>
  );
}
