"""
Rebind the Task Breakdown "Users" column from [Active Agent Users] to [All Active Users].

Problem: [Active Agent Users] hard-codes
    KEEPFILTERS('Chat + Agent Interactions (Audit Logs)'[Agent Filter (Normalized)] = "Agents")
so when the page's Agent Filter buttons select Cowork (or Copilot) the intersection
is empty and every Users cell goes blank, while Sessions still populates.

Fix: the Organization and Agent tables (and the Value Outcome table's sort) use
[All Active Users] instead, which has the same active-user logic without the
hard-coded segment, so it follows whichever Licensed/Agents/Copilot/Cowork button
is selected. Other pages that deliberately report agent users are left alone.

Usage: python scripts/Fix-TaskBreakdown-UsersMeasure.py [--dry-run] <template.pbit> ...
"""
import json, os, re, sys, zipfile

OLD = "Active Agent Users"
NEW = "All Active Users"
PAGE_NAME = "Task Breakdown"
VISUAL_RE = re.compile(r"^Report/definition/pages/([^/]+)/visuals/[^/]+/visual\.json$")
PAGE_RE = re.compile(r"^Report/definition/pages/([^/]+)/page\.json$")


def patch(pbit, dry_run):
    with zipfile.ZipFile(pbit) as z:
        infos = z.infolist()
        data = {i.filename: z.read(i.filename) for i in infos}

    page_ids = set()
    for n, b in data.items():
        m = PAGE_RE.match(n)
        if m and PAGE_NAME in json.loads(b.decode("utf-8")).get("displayName", ""):
            page_ids.add(m.group(1))
    if not page_ids:
        print(f"  {os.path.basename(pbit)}: no {PAGE_NAME} page - skipped")
        return False

    changed = {}
    for n, b in data.items():
        m = VISUAL_RE.match(n)
        if not m or m.group(1) not in page_ids:
            continue
        txt = b.decode("utf-8")
        hits = txt.count(OLD)
        if hits:
            new_txt = txt.replace(OLD, NEW)
            json.loads(new_txt)
            changed[n] = new_txt.encode("utf-8")
            print(f"  {os.path.basename(pbit)}: {n.split('/')[-2]} ({hits} reference(s))")

    if not changed:
        print(f"  {os.path.basename(pbit)}: already patched - skipped")
        return False
    if dry_run:
        return True

    tmp = pbit + ".__new"
    with zipfile.ZipFile(tmp, "w") as z:
        for i in infos:  # preserve original entry order and compression
            z.writestr(i, changed.get(i.filename, data[i.filename]))
    os.replace(tmp, pbit)
    return True


if __name__ == "__main__":
    dry = "--dry-run" in sys.argv
    targets = [a for a in sys.argv[1:] if not a.startswith("--")]
    print("DRY RUN\n" if dry else "APPLYING\n")
    n = sum(1 for t in targets if patch(t, dry))
    print(f"\n{n} template(s) {'would be ' if dry else ''}patched.")
