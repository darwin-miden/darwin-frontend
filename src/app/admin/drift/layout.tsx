import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Drift",
};

export default function DriftLayout({ children }: { children: ReactNode }) {
  return children;
}
