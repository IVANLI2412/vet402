"use client";

/**
 * SiteHeader — the running head of the document.
 *
 * 2026-08-13 vet402: rebuilt in the RFC plaintext world. The bar sits on the
 * ground colour (not on paper) so the sheet below reads as a separate object,
 * and it closes with the single navy rule that opens every RFC page.
 *
 * Vouch is Web3/stealth (pseudonymous), English-only, so no product name
 * localization or language switcher is needed here.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { buttonClass } from "@/components/ui/Button";
import { Wordmark } from "@/components/site/Wordmark";
import TrackedLink from "@/components/site/TrackedLink";

type NavItem = { label: string; href: string };

const NAV_ITEMS: NavItem[] = [
  { label: "Check a seller", href: "/x402/check-a-seller" },
  { label: "Observatory", href: "/observatory" },
  { label: "Docs", href: "/docs/api" },
  { label: "Dashboard", href: "/dashboard/login" },
  { label: "Get API key", href: "/signup" },
];

function currentNav(pathname: string, href: string): "page" | undefined {
  if (href.includes("#")) return undefined;
  if (pathname === href || (href !== "/" && pathname.startsWith(`${href}/`))) return "page";
  return undefined;
}

function SiteHeaderMobileMenu({ pathname }: { pathname: string }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const menuId = useId();
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLElement>(null);
  const closeMenu = useCallback(() => setMobileOpen(false), []);

  const onEscape = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setMobileOpen(false);
        menuButtonRef.current?.focus();
      }
    },
    [],
  );

  useEffect(() => {
    if (!mobileOpen) return;
    const firstLink = menuRef.current?.querySelector("a");
    firstLink?.focus();
  }, [mobileOpen]);

  return (
    <>
      <button
        ref={menuButtonRef}
        type="button"
        className="md:hidden -mr-2 flex h-11 w-16 items-center justify-end text-[0.84375rem] text-brand-deep"
        aria-expanded={mobileOpen}
        aria-controls={menuId}
        aria-label="Site menu"
        onClick={() => setMobileOpen((open) => !open)}
        onKeyDown={onEscape}
      >
        {mobileOpen ? (
          <span aria-hidden="true">Close</span>
        ) : (
          "Menu"
        )}
      </button>
      {mobileOpen ? (
        <nav
          ref={menuRef}
          id={menuId}
          aria-label="Mobile navigation"
          onKeyDown={onEscape}
          onClick={(e) => {
            if ((e.target as HTMLElement).closest("a")) closeMenu();
          }}
          className="absolute left-0 right-0 top-full z-40 flex max-h-[calc(100dvh-3.5rem)] flex-col overflow-y-auto overscroll-contain border-b border-brand-deep bg-paper px-5 py-3 md:hidden"
        >
          {NAV_ITEMS.map((item) =>
            item.href === "/signup" ? (
              <TrackedLink
                key={item.href}
                href={item.href}
                event="lp_cta_click"
                props={{ position: "drawer_signup" }}
                ariaCurrent={currentNav(pathname, item.href)}
                className={buttonClass({ className: "mt-4 w-full" })}
              >
                {item.label}
              </TrackedLink>
            ) : (
              <TrackedLink
                key={item.href}
                href={item.href}
                event="nav_click"
                props={{ label: item.label }}
                ariaCurrent={currentNav(pathname, item.href)}
                className="min-h-11 border-b border-hair py-3 text-[0.84375rem] text-brand hover:text-brand-deep"
              >
                {item.label}
              </TrackedLink>
            ),
          )}
        </nav>
      ) : null}
    </>
  );
}

export function SiteHeader() {
  const pathname = usePathname() ?? "";

  const mainNav = NAV_ITEMS.filter((item) => item.href !== "/signup" && item.href !== "/dashboard/login");
  const dashboard = NAV_ITEMS.find((item) => item.href === "/dashboard/login")!;
  const signup = NAV_ITEMS.find((item) => item.href === "/signup")!;

  return (
    <header
      className="site-header sticky top-0 z-40 border-b border-brand-deep bg-ground"
    >
      <div className="relative px-4 sm:px-6 md:px-8">
        <div className="mx-auto flex h-14 w-full max-w-[var(--column)] items-center justify-between gap-6 px-[var(--sheet-pad)] lg:max-w-[1200px]">
          <Link href="/" className="inline-flex h-11 shrink-0 items-center" aria-label="vet402 home">
            <Wordmark className="text-[1.0625rem] leading-none" />
          </Link>

          <nav
            aria-label="Main navigation"
            className="hidden items-center gap-4 text-[0.84375rem] text-brand-lift md:flex lg:gap-6"
          >
            {mainNav.map((item) => (
              <TrackedLink
                key={item.href}
                href={item.href}
                event="nav_click"
                props={{ label: item.label }}
                ariaCurrent={currentNav(pathname, item.href)}
                className="inline-flex h-11 items-center hover:text-brand-deep"
              >
                {item.label}
              </TrackedLink>
            ))}
          </nav>

          <div className="hidden shrink-0 items-center gap-4 md:flex">
            <TrackedLink
              href={dashboard.href}
              event="nav_click"
              props={{ label: dashboard.label }}
              ariaCurrent={currentNav(pathname, dashboard.href)}
              className="inline-flex h-11 items-center text-[0.84375rem] text-brand-lift hover:text-brand-deep"
            >
              {dashboard.label}
            </TrackedLink>
            <TrackedLink
              href={signup.href}
              event="lp_cta_click"
              props={{ position: "header_signup" }}
              ariaCurrent={currentNav(pathname, signup.href)}
              className={buttonClass()}
            >
              {signup.label}
            </TrackedLink>
          </div>

          <SiteHeaderMobileMenu key={pathname} pathname={pathname} />
        </div>
      </div>
    </header>
  );
}