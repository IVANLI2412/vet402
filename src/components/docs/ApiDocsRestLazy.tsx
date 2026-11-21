"use client";

import dynamic from "next/dynamic";

const ApiDocsRest = dynamic(() => import("@/components/docs/ApiDocsRest"), {
  ssr: false,
  loading: () => <p className="text-[0.84375rem] text-brand">Loading API reference…</p>,
});

export default function ApiDocsRestLazy({ inviteRequired }: { inviteRequired: boolean }) {
  return <ApiDocsRest inviteRequired={inviteRequired} />;
}