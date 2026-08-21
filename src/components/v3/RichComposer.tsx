"use client";

import * as React from "react";
import { useEffect } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { Bold, Italic, Link2, List, ListOrdered, Quote } from "lucide-react";

export type RichComposerValue = { html: string; text: string };

export function RichComposer({
  value,
  onChange,
  placeholder = "Write a message",
}: {
  value: RichComposerValue;
  onChange: (value: RichComposerValue) => void;
  placeholder?: string;
}) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit,
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
      }),
    ],
    content: value.html,
    editorProps: {
      attributes: {
        class: "mail-compose-editor mail-focus-ring",
        "aria-label": "Message",
        "data-placeholder": placeholder,
      },
    },
    onUpdate: ({ editor: current }) =>
      onChange({ html: current.getHTML(), text: current.getText() }),
  });

  useEffect(() => {
    if (!editor || editor.isFocused || editor.getHTML() === value.html) return;
    editor.commands.setContent(value.html || "");
  }, [editor, value.html]);

  if (!editor) return <div className="mail-compose-editor" aria-label="Loading editor" />;

  const addLink = () => {
    const previous = editor.getAttributes("link").href as string | undefined;
    const href = window.prompt("Link to", previous ?? "");
    if (href === null) return;
    if (!href) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    const safe = /^(https?:|mailto:)/i.test(href) ? href : `https://${href}`;
    editor.chain().focus().extendMarkRange("link").setLink({ href: safe }).run();
  };

  return (
    <div className="mail-rich-composer">
      <div className="mail-compose-tools" role="toolbar" aria-label="Formatting">
        <Tool label="Bold" active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}>
          <Bold aria-hidden />
        </Tool>
        <Tool label="Italic" active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}>
          <Italic aria-hidden />
        </Tool>
        <Tool label="Bulleted list" active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}>
          <List aria-hidden />
        </Tool>
        <Tool label="Numbered list" active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
          <ListOrdered aria-hidden />
        </Tool>
        <Tool label="Quote" active={editor.isActive("blockquote")} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
          <Quote aria-hidden />
        </Tool>
        <Tool label="Link" active={editor.isActive("link")} onClick={addLink}>
          <Link2 aria-hidden />
        </Tool>
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}

function Tool({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      className="mail-compose-tool mail-focus-ring"
      onClick={onClick}
    >
      {children}
    </button>
  );
}
