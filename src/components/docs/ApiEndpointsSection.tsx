"use client";

import CodeBlock from "@/components/docs/CodeBlock";
import DocBodySection from "@/components/docs/DocBodySection";
import { API_DOC_ENDPOINTS, apiEndpointId } from "@/lib/docs/api-endpoints-data";

export default function ApiEndpointsSection() {
  return (
  <>
        {API_DOC_ENDPOINTS.map((ep) => (
          <DocBodySection
            key={apiEndpointId(ep)}
            id={apiEndpointId(ep)}
            className="space-y-3 border-t border-hair pt-6 text-[0.84375rem] first:border-t-brand-deep"
            title={
              <span className="break-all font-[family-name:var(--font-display)] font-semibold text-brand-deep">
                <span className="marker marker-plan mr-2 align-middle">{ep.method}</span>
                <span className="sr-only"> </span>
                {ep.path}
              </span>
            }
          >
            <p className="text-brand">{ep.note}</p>

            {ep.request && (
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-brand-lift">Request body</p>
                <CodeBlock code={ep.request} label={`Request body for ${ep.method} ${ep.path}`} />
              </div>
            )}

            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-brand-lift">
                {ep.responseHeading ?? "Response"}
              </p>
              {ep.responseNote ? <p className="mb-2 text-brand">{ep.responseNote}</p> : null}
              <CodeBlock code={ep.response} label={`Response for ${ep.method} ${ep.path}`} />
            </div>
          </DocBodySection>
        ))}
  </>
  );
}