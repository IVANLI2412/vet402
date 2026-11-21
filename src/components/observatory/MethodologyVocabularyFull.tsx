import { OBSERVATORY_VOCABULARY, VOCABULARY_GROUP_LABELS } from "@/lib/observatory/vocabulary";

/** §10 full definitions (also rendered via vocabulary-html route). */
export default function MethodologyVocabularyFull() {
  return (
    <>
      {(Object.keys(VOCABULARY_GROUP_LABELS) as (keyof typeof VOCABULARY_GROUP_LABELS)[]).map((group) => (
        <div key={group} className="mt-6">
          <p className="text-brand-deep">{VOCABULARY_GROUP_LABELS[group]}</p>
          <dl className="mt-2 max-w-[70ch]">
            {OBSERVATORY_VOCABULARY.filter((t) => t.group === group).map((t) => (
              <div key={t.term} className="mt-3">
                <dt id={`term-${t.term}`} className="text-brand-deep">
                  <code>{t.term}</code>
                </dt>
                <dd className="doc-p mt-1">{t.definition}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </>
  );
}