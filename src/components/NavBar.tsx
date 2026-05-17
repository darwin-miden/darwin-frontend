import Link from "next/link";
import { LogoFull } from "./Logo";

/**
 * Shared top nav. Uses globals.css design tokens (.nav, .nav-inner,
 * .nav-logo, .nav-links, .nav-cta). The active page is passed in so
 * we can highlight it without a router subscription on the server.
 */
export type NavKey = "home" | "baskets" | "accounts" | "flows" | "status";

export function NavBar({ active }: { active?: NavKey }) {
  const link = (key: NavKey, href: string, label: string) => (
    <Link
      href={href}
      style={{
        color: active === key ? "var(--ink)" : "var(--ink-2)",
        borderBottom:
          active === key ? "1px solid var(--orange)" : "1px solid transparent",
        paddingBottom: 2,
      }}
    >
      {label}
    </Link>
  );

  return (
    <header className="nav">
      <div className="container nav-inner">
        <Link href="/" className="nav-logo">
          <LogoFull />
        </Link>
        <nav className="nav-links">
          {link("baskets", "/baskets", "Baskets")}
          {link("accounts", "/accounts", "Accounts")}
          {link("flows", "/flows", "Flows")}
          {link("status", "/status", "Status")}
        </nav>
        <a
          className="nav-cta"
          href="https://github.com/darwin-miden"
          target="_blank"
          rel="noreferrer"
        >
          GitHub →
        </a>
      </div>
    </header>
  );
}
