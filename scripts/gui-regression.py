from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


def body_text(page) -> str:
    return page.locator("body").inner_text()


def wait_for_body_text(page, expected: str, timeout_ms: int) -> None:
    page.wait_for_function(
        "(text) => document.body.innerText.includes(text)",
        arg=expected,
        timeout=timeout_ms,
    )


def workspace_root_from_script() -> str:
    return str(Path(__file__).resolve().parents[2])


def ensure_workspace(page, workspace_root: str, timeout_ms: int) -> None:
    if workspace_root in body_text(page):
        return

    page.get_by_role("button", name="Add workspace").click()
    page.locator("input").first.fill(workspace_root)
    page.get_by_role("button", name="Add", exact=True).click()
    wait_for_body_text(page, workspace_root, timeout_ms)


def ensure_workspace_expanded(page, timeout_ms: int) -> None:
    if page.locator(".awb-tree__session").count() > 0:
        return

    page.locator(".awb-workspace__header").first.click()
    page.wait_for_function(
        "() => document.querySelectorAll('.awb-tree__session').length > 0",
        timeout=timeout_ms,
    )


def current_session_rows(page) -> int:
    return page.locator(".awb-tree__session").count()


def create_session(page, timeout_ms: int) -> None:
    before = current_session_rows(page)
    page.locator(".awb-workspace__add").first.click()
    page.wait_for_function(
        "(previousCount) => document.querySelectorAll('.awb-tree__session').length > previousCount",
        arg=before,
        timeout=timeout_ms,
    )


def current_turn_count(page) -> int:
    return page.locator(".awb-turn").count()


def send_prompt(page, prompt: str) -> None:
    page.locator("textarea[placeholder='Type a prompt for the active session...']").fill(prompt)
    page.get_by_role("button", name="Send").click()


def ensure_context_menu(page, timeout_ms: int) -> None:
    page.locator(".awb-tree__session").first.click(button="right")
    page.wait_for_function(
        "() => Boolean(document.querySelector('.awb-session-menu'))",
        timeout=timeout_ms,
    )


def click_enabled_approve(page, timeout_ms: int) -> None:
    wait_for_enabled_approve(page, timeout_ms)
    page.locator("button:not([disabled])").filter(has_text="Approve").first.click()


def wait_for_enabled_approve(page, timeout_ms: int) -> None:
    page.wait_for_function(
        """
        () => [...document.querySelectorAll('button')]
          .some((button) => button.textContent?.trim() == 'Approve' && !button.disabled)
        """,
        timeout=timeout_ms,
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run Another Workbench phase-2 GUI regression checks over CDP."
    )
    parser.add_argument(
        "--cdp",
        default="http://127.0.0.1:9345",
        help="CDP endpoint exposed by the running Electron app.",
    )
    parser.add_argument(
        "--page-url-fragment",
        default="/another-workbench/apps/desktop/dist-web/index.html",
        help="Unique URL fragment used to find the Another Workbench window.",
    )
    parser.add_argument(
        "--timeout-ms",
        type=int,
        default=180_000,
        help="Timeout for the longest GUI waits.",
    )
    args = parser.parse_args()

    workspace_root = workspace_root_from_script()
    screenshot_dir = Path(tempfile.gettempdir()) / "another-workbench-gui"
    screenshot_dir.mkdir(parents=True, exist_ok=True)
    screenshot_path = screenshot_dir / f"gui-regression-{int(time.time())}.png"

    results: list[dict[str, object]] = []

    def record(case_id: str, status: str, **details: object) -> None:
        results.append({"id": case_id, "status": status, "details": details})

    page = None
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(args.cdp)
            try:
                pages = [item for context in browser.contexts for item in context.pages]
                page = next(
                    (
                        candidate
                        for candidate in pages
                        if args.page_url_fragment in candidate.url
                    ),
                    None,
                )
                if page is None:
                    raise RuntimeError(
                        "Could not find Another Workbench page. "
                        f"Available URLs: {[candidate.url for candidate in pages]}"
                    )

                page.bring_to_front()
                page.wait_for_load_state("domcontentloaded")

                is_prod_entry = page.url.endswith("dist-web/index.html")
                record("TC-01", "passed" if is_prod_entry else "failed", url=page.url)

                has_error_page = page.get_by_role("heading", name="无法访问此网站").count() > 0
                record(
                    "TC-02",
                    "failed" if has_error_page else "passed",
                    has_error_page=has_error_page,
                )

                ensure_workspace(page, workspace_root, args.timeout_ms)
                workspace_visible = workspace_root in body_text(page)
                record(
                    "TC-03",
                    "passed" if workspace_visible else "failed",
                    workspace_root=workspace_root,
                )

                ensure_workspace_expanded(page, args.timeout_ms)
                expanded = current_session_rows(page) > 0
                record(
                    "TC-04",
                    "passed" if expanded else "failed",
                    session_rows=current_session_rows(page),
                )

                create_session(page, args.timeout_ms)
                session_rows = current_session_rows(page)
                record(
                    "TC-05",
                    "passed" if session_rows > 0 else "failed",
                    session_rows=session_rows,
                )

                send_prompt(page, "Reply with exactly the word hi.")
                wait_for_body_text(page, "\nhi\n", args.timeout_ms)
                record("TC-06", "passed", assistant_reply="hi")

                ensure_context_menu(page, args.timeout_ms)
                menu_text = page.locator(".awb-session-menu").inner_text()
                has_expected_actions = all(
                    label in menu_text
                    for label in ("Archive", "Copy session id", "Open rollout", "Reload")
                )
                record(
                    "TC-07",
                    "passed" if has_expected_actions else "failed",
                    menu_text=menu_text,
                )

                page.get_by_role("button", name="Copy session id").click()
                page.wait_for_timeout(600)
                copied_status = page.locator(".awb-status").inner_text().strip()
                record(
                    "TC-08",
                    "passed" if copied_status.startswith("Copied session-") else "failed",
                    composer_status=copied_status,
                )

                turns_before_process = current_turn_count(page)
                send_prompt(
                    page,
                    "Use one shell command to print the current working directory, then answer in one short sentence with that result.",
                )
                wait_for_enabled_approve(page, args.timeout_ms)
                record("TC-09", "passed", approval_requested=True)

                click_enabled_approve(page, args.timeout_ms)
                page.wait_for_function(
                    "(previousCount) => document.querySelectorAll('.awb-turn').length > previousCount",
                    arg=turns_before_process,
                    timeout=args.timeout_ms,
                )
                wait_for_body_text(page, "Show process", args.timeout_ms)
                record("TC-10", "passed", process_collapsed=True)

                page.get_by_role("button", name="Show process").click()
                wait_for_body_text(page, "Tool activity", args.timeout_ms)
                record("TC-11", "passed", process_expanded=True)

                page.locator(".awb-chat-tree__node").first.dblclick()
                wait_for_body_text(page, "Jumped to", args.timeout_ms)
                turn_count_after_jump = current_turn_count(page)
                record(
                    "TC-12",
                    "passed" if turn_count_after_jump == 1 else "failed",
                    visible_turns_after_jump=turn_count_after_jump,
                )

                page.screenshot(path=str(screenshot_path), full_page=True)
                record("TC-13", "passed", screenshot=str(screenshot_path))
            finally:
                browser.close()
    except PlaywrightTimeoutError as error:
        evidence: dict[str, object] = {
            "results": results,
            "error": f"timeout: {error}",
        }
        if page is not None:
            try:
                page.screenshot(path=str(screenshot_path), full_page=True)
                evidence["screenshot"] = str(screenshot_path)
                evidence["body_text"] = body_text(page)[:4000]
            except Exception as screenshot_error:  # pragma: no cover
                evidence["evidence_error"] = str(screenshot_error)
        print(json.dumps(evidence, ensure_ascii=False, indent=2))
        return 1
    except Exception as error:  # pragma: no cover
        evidence: dict[str, object] = {
            "results": results,
            "error": str(error),
        }
        if page is not None:
            try:
                page.screenshot(path=str(screenshot_path), full_page=True)
                evidence["screenshot"] = str(screenshot_path)
                evidence["body_text"] = body_text(page)[:4000]
            except Exception as screenshot_error:
                evidence["evidence_error"] = str(screenshot_error)
        print(json.dumps(evidence, ensure_ascii=False, indent=2))
        return 1

    print(
        json.dumps(
            {
                "results": results,
                "ok": all(item["status"] == "passed" for item in results),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
