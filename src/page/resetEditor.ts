import type { ResetCodeResult } from "../shared/messages";

/**
 * Replaces the problem's code with LeetCode's default template, the same
 * result as the editor's Reset button, and removes drafts saved in other
 * languages so switching language doesn't reveal an old solution either.
 *
 * Without `force`, it first checks the editor. If it holds anything other
 * than a default template (work in progress from another device, or an old
 * solution: the two can't be told apart), it changes nothing and returns
 * `existingCode: true` so the user can choose. With `force`, it always resets.
 *
 * Runs in the PAGE's JavaScript world (editorBridge.ts, a manifest content
 * script with world: "MAIN"), because the Monaco editor object isn't visible
 * to isolated content scripts.
 *
 * Verified against leetcode.com in October 2026:
 * - Default code comes from the public GraphQL `question.codeSnippets`.
 * - Drafts live in IndexedDB "LeetCode-problems" / store "problem_code",
 *   keyed "<questionId>_<userId>_<langSlug>" (plus "...-updated-time").
 * - The language comes from localStorage "<questionId>_<userId>_lang",
 *   falling back to "global_lang".
 * - LeetCode autosaves on executeEdits() but NOT on model.setValue(), so we
 *   edit first (saves the template) and then setValue() the same text, which
 *   clears undo history so Ctrl+Z can't bring the old solution back.
 */
export async function resetEditorToDefault(slug: string, force = false): Promise<ResetCodeResult> {
  interface Range { startLineNumber: number }
  interface Model {
    uri: { scheme: string };
    getValue(): string;
    setValue(value: string): void;
    getFullModelRange(): Range;
  }
  interface Editor {
    getModel(): Model | null;
    executeEdits(source: string, edits: { range: Range; text: string }[]): boolean;
  }
  interface MonacoGlobal {
    editor?: { getEditors?: () => Editor[] };
  }
  interface Question {
    questionId: string;
    codeSnippets: { langSlug: string; code: string }[] | null;
  }

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  // Line endings and trailing whitespace don't count as edits.
  const normalize = (code: string) =>
    code.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd()).join("\n").trim();
  const parseJson = (raw: string | null): unknown => {
    try {
      return raw === null ? null : JSON.parse(raw);
    } catch {
      return null;
    }
  };

  // 1. Default code for every language.
  let question: Question | null;
  try {
    const response = await fetch("/graphql/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        query:
          "query blindPracticeDefaultCode($titleSlug: String!) {" +
          " question(titleSlug: $titleSlug) { questionId codeSnippets { langSlug code } } }",
        variables: { titleSlug: slug },
      }),
    });
    question = (await response.json())?.data?.question ?? null;
  } catch (error) {
    return { ok: false, reason: `Couldn't load the default code: ${String(error)}` };
  }
  if (!question?.codeSnippets?.length) {
    return { ok: false, reason: "This problem has no default code." };
  }

  // 2. Wait for the code editor (up to 20 s on a slow load).
  let editor: Editor | undefined;
  for (let i = 0; i < 80 && !editor; i++) {
    const monaco = (window as unknown as { monaco?: MonacoGlobal }).monaco;
    editor = monaco?.editor?.getEditors?.().find((e) => e.getModel()?.uri.scheme === "file");
    if (!editor) await sleep(250);
  }
  const activeEditor = editor;
  const model = activeEditor?.getModel();
  if (!activeEditor || !model) return { ok: false, reason: "The code editor didn't load." };
  // Let LeetCode finish restoring its saved draft before we replace it.
  await sleep(1000);

  // 3. Current language.
  const qid = question.questionId;
  const langKeyPattern = new RegExp(`^${qid}_\\d+_lang$`);
  const langKey = Object.keys(localStorage).find((k) => langKeyPattern.test(k));
  const storedLang = (langKey && parseJson(localStorage.getItem(langKey))) || parseJson(localStorage.getItem("global_lang"));
  const lang = typeof storedLang === "string" ? storedLang : "cpp";
  const snippet = question.codeSnippets.find((s) => s.langSlug === lang);
  if (!snippet) return { ok: false, reason: `No default code for ${lang}.`, lang };

  // Code that isn't empty and isn't any language's template is the user's.
  const templates = new Set(question.codeSnippets.map((s) => normalize(s.code)));
  const isUsersCode = (code: string) => {
    const n = normalize(code);
    return n !== "" && !templates.has(n);
  };
  if (!force) {
    // LeetCode can restore a saved draft a little late on slow loads; give it
    // a moment so we don't mistake a not-yet-restored editor for an empty one.
    for (let i = 0; i < 6 && !isUsersCode(model.getValue()); i++) await sleep(250);
    if (isUsersCode(model.getValue())) return { ok: false, existingCode: true, lang, reason: "The editor already has code." };
  }

  // 4. Replace the code. executeEdits makes LeetCode save it; setValue then
  // clears undo history so the old solution can't be recovered with Ctrl+Z.
  const replace = () => {
    activeEditor.executeEdits("blind-practice-reset", [{ range: model.getFullModelRange(), text: snippet.code }]);
    model.setValue(snippet.code);
  };
  const before = model.getValue();
  replace();
  // LeetCode's own draft restore can still land after our edit.
  await sleep(1200);
  const after = model.getValue();
  if (after !== snippet.code && isUsersCode(after)) {
    if (force) {
      replace();
    } else {
      // Our edit already saved the template over that draft. Edit the user's
      // code back in, so LeetCode saves it again, and let them choose.
      model.setValue(snippet.code);
      activeEditor.executeEdits("blind-practice-restore", [{ range: model.getFullModelRange(), text: after }]);
      return { ok: false, existingCode: true, lang, reason: "The editor already has code." };
    }
  } else if (after === before && before !== snippet.code) {
    replace();
  }

  // 5. Remove drafts this problem has in other languages. Done last, so a
  // run that ends up keeping the user's code deletes nothing.
  let removedDrafts = 0;
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("LeetCode-problems");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (db.objectStoreNames.contains("problem_code")) {
      const draftPattern = new RegExp(`^${qid}_\\d+_([^_]+?)(-updated-time)?$`);
      const store = db.transaction("problem_code", "readwrite").objectStore("problem_code");
      const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
        const request = store.getAllKeys();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      for (const key of keys) {
        const match = draftPattern.exec(String(key));
        if (match && match[1] !== lang) {
          store.delete(key);
          if (!match[2]) removedDrafts++;
        }
      }
      await new Promise<void>((resolve, reject) => {
        store.transaction.oncomplete = () => resolve();
        store.transaction.onerror = () => reject(store.transaction.error);
      });
    }
    db.close();
  } catch {
    // Not fatal: the current language has already been reset.
  }

  return { ok: true, lang, removedDrafts };
}
