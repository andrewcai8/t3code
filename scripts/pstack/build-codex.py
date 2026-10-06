#!/usr/bin/env python3
"""Build the Codex pstack plugin from an upstream cursor/plugins pstack tree.

usage: build-codex.py SRC OUT VERSION COMMIT

SRC is a pstack directory with overlay.patch applied (build.sh passes one).
OUT is replaced. Codex-only material (supplementary skills, the runtime-mapping
reference, notices, manifest templates) lives in codex-extras beside this file.
"""
import json
import pathlib
import shutil
import sys

import yaml

HERE = pathlib.Path(__file__).resolve().parent
EXTRAS = HERE / "codex-extras"
CURSOR_ONLY_PATHS = [".cursor-plugin", ".gitignore", "README.md", "automations", "docs"]
CURSOR_ONLY_KEYS = ("disable-model-invocation:", "mode:", "icon:", "color:", "reminder:", "paths:")
MODEL_RULES = (
    ("~/.cursor/rules/pstack-models.mdc", "~/.codex/pstack-models.md"),
    ("`pstack-models.mdc`", "`pstack-models.md`"),
)


def adapt_skill(path: pathlib.Path) -> None:
    slug = path.parent.name
    lines = path.read_text().split("\n")
    close = lines.index("---", 1)
    head = [l for l in lines[1:close] if not l.startswith(CURSOR_ONLY_KEYS)]
    meta = yaml.safe_load("\n".join(head))
    if meta.get("name") != slug:
        meta["name"] = slug
        head = yaml.safe_dump(meta, sort_keys=False, allow_unicode=True).rstrip("\n").split("\n")
    link = "references/codex-tools.md" if slug == "poteto-mode" else "../poteto-mode/references/codex-tools.md"
    note = f"On Codex, apply the [runtime mapping]({link}) before using the platform-specific tools or model defaults below."
    text = "\n".join(["---", *head, "---", "", note, *lines[close + 1:]])
    for cursor_path, codex_path in MODEL_RULES:
        text = text.replace(cursor_path, codex_path)
    path.write_text(text)


def main(src: str, out: str, version: str, commit: str) -> None:
    src_dir, out_dir = pathlib.Path(src), pathlib.Path(out)
    base_version = version.split("+", 1)[0]
    shutil.rmtree(out_dir, ignore_errors=True)
    shutil.copytree(src_dir, out_dir, ignore=shutil.ignore_patterns(".git", "node_modules", ".DS_Store"))
    for rel in CURSOR_ONLY_PATHS:
        target = out_dir / rel
        shutil.rmtree(target) if target.is_dir() else target.unlink(missing_ok=True)
    for skill in sorted((out_dir / "skills").glob("*/SKILL.md")):
        adapt_skill(skill)
    shutil.copytree(EXTRAS / "skills", out_dir / "skills", dirs_exist_ok=True)
    for name in ("LICENSE-cursor-team-kit", "LICENSE-pstack-claude", "NOTICE-skills.md"):
        shutil.copy2(EXTRAS / name, out_dir / name)
    manifest = json.loads((EXTRAS / "plugin.template.json").read_text())
    manifest["version"] = version
    for key in ("description",):
        manifest[key] = manifest[key].replace("0.15.0", base_version)
    manifest["interface"]["longDescription"] = manifest["interface"]["longDescription"].replace("0.15.0", base_version)
    (out_dir / ".codex-plugin").mkdir(exist_ok=True)
    (out_dir / ".codex-plugin" / "plugin.json").write_text(json.dumps(manifest, indent=2) + "\n")
    upstream = json.loads((EXTRAS / "upstream.template.json").read_text())
    upstream.update(commit=commit, version=base_version)
    (out_dir / "upstream.json").write_text(json.dumps(upstream, indent=2) + "\n")


if __name__ == "__main__":
    main(*sys.argv[1:5])
