"use client";

import dynamic from "next/dynamic";

// next/dynamic with ssr:false is allowed only in a Client Component (Turbopack build rule).
const ApiEndpointsSection = dynamic(() => import("@/components/docs/ApiEndpointsSection"), {
  ssr: false,
  loading: () => <p className="text-[0.84375rem] text-brand">Loading endpoint reference…</p>,
});

export default ApiEndpointsSection;
