"""Structural guards for release.yml: run `python3 tests/workflows/test_release.py`.

A release must be recoverable: semantic-release tags first, so if the image
build or push then fails, a plain re-run cuts nothing new and the image would
never exist. Hence two jobs -- `release` (tags, no package rights) and
`build` (the tag's tree, smoke-tested, then pushed) -- and a manual
`workflow_dispatch` that rebuilds an existing tag.
"""
import pathlib

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[2]


def workflow():
    wf = yaml.safe_load((ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8"))
    # PyYAML reads the bare key `on` as the boolean True.
    wf["on"] = wf.pop(True, wf.get("on"))
    return wf


def test_semantic_release_job_cannot_push_packages():
    rel = workflow()["jobs"]["release"]
    perms = rel.get("permissions", {})
    assert perms.get("contents") == "write"
    assert "packages" not in perms, "the job running semantic-release's npm deps must not hold packages: write"
    assert "version" in rel.get("outputs", {})


def test_build_job_builds_the_tag_and_smoke_tests_before_pushing():
    build = workflow()["jobs"]["build"]
    assert build.get("needs") == "release"
    assert build.get("permissions", {}).get("packages") == "write"
    assert build.get("permissions", {}).get("contents") == "read"
    steps = build["steps"]
    checkout = next(s for s in steps if str(s.get("uses", "")).startswith("actions/checkout@"))
    assert "refs/tags/v" in str(checkout.get("with", {}).get("ref", "")), "build the tagged commit, not the branch head"
    runs = [s.get("run", "") for s in steps]
    smoke = next(i for i, r in enumerate(runs) if "tests/image/smoke.sh" in r)
    push = next(i for i, r in enumerate(runs) if "docker push" in r)
    assert smoke < push, "smoke-test the image before pushing it"


def test_an_existing_tag_can_be_rebuilt_manually():
    wf = workflow()
    inputs = wf["on"]["workflow_dispatch"]["inputs"]
    assert "version" in inputs
    # The input never lands in a script verbatim (injection): only via env,
    # and it is validated as X.Y.Z with an existing tag before use.
    build = wf["jobs"]["build"]
    text = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
    assert "inputs.version" in str(build.get("env", {}))
    for s in build["steps"]:
        assert "inputs.version" not in s.get("run", ""), s.get("name")
    assert "git ls-remote" in text and "[0-9]+\\.[0-9]+\\.[0-9]+" in text


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
