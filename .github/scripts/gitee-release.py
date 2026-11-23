# -*- coding: utf-8 -*-
"""在 CI 中幂等地创建 Gitee Release 并上传 tgz 资产。

凭证来自环境变量 GITEE_API_TOKEN（GitHub Actions secret），绝不落盘、不打印。
Gitee v5 API 写操作用 form(urlencode)，资产用 multipart/form-data。
若 tag 尚未镜像到 Gitee，轮询等待（sync-gitee.yml 并行推送中），超时则跳过并告警。
"""
import os
import json
import ssl
import time
import uuid
import urllib.request
import urllib.parse

TOKEN = os.environ.get("GITEE_API_TOKEN", "").strip()
TAG = os.environ.get("TAG", "").strip()
TGZ = os.environ.get("TGZ", "").strip()
SHA = os.environ.get("GITHUB_SHA", "").strip()
OWNER, REPO = "wtt520wyl", "dsh-plugin-deepseek-chat"
API = "https://gitee.com/api/v5/repos/%s/%s" % (OWNER, REPO)
CTX = ssl.create_default_context()

if not TOKEN:
    raise SystemExit("GITEE_API_TOKEN 未设置")
if not TAG:
    raise SystemExit("TAG 未设置")
if not TGZ or not os.path.isfile(TGZ):
    raise SystemExit("TGZ 不存在: %s" % TGZ)

BODY = (
    "## %s 全自动流程初步真机验证通过（持续完善中）\n\n"
    "本版把全自动投递通道从实验性推进到初步真机验证通过，并同步修正真机验证中发现的多处问题。\n\n"
    "安装：在插件市场搜索 deepseek-chat 安装，或下载本 Release 的 tgz 用 DSH 插件管理器安装。\n"
) % TAG


def api_get(url, params=None):
    q = dict(params or {})
    q["access_token"] = TOKEN
    full = url + "?" + urllib.parse.urlencode(q)
    with urllib.request.urlopen(urllib.request.Request(full), context=CTX, timeout=90) as r:
        return json.loads(r.read().decode("utf-8"))


def api_post_form(url, params):
    data = urllib.parse.urlencode(params).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"},
    )
    with urllib.request.urlopen(req, context=CTX, timeout=90) as r:
        return json.loads(r.read().decode("utf-8"))


# 1. 等 tag 镜像到 Gitee（sync-gitee.yml 与本页面并行推送）
tag_ready = False
for attempt in range(1, 13):
    try:
        tags = api_get(API + "/tags")
        if any(t.get("name") == TAG for t in tags):
            tag_ready = True
            print("Gitee tag %s 已就位（第 %d 次检查）" % (TAG, attempt))
            break
    except Exception as exc:  # noqa: BLE001 - CI 脚本，失败重试即可
        print("检查 tag 失败（第 %d 次）：%s" % (attempt, exc))
    if attempt < 12:
        time.sleep(10)
if not tag_ready:
    print("::warning::Gitee 上未等到 tag %s（可能 sync-gitee 尚未完成），跳过 Gitee Release；可重跑 workflow_dispatch 补建。" % TAG)
    raise SystemExit(0)

# 2. 幂等：已有同 tag 的 Release 则复用
releases = api_get(API + "/releases")
existing = next((r for r in releases if r.get("tag_name") == TAG), None)
if existing:
    rel_id = existing.get("id")
    print("Gitee Release %s 已存在（id=%s），跳过创建。" % (TAG, rel_id))
else:
    created = api_post_form(API + "/releases", {
        "access_token": TOKEN,
        "tag_name": TAG,
        "name": "%s 全自动流程初步真机验证通过" % TAG,
        "body": BODY,
        "target_commitish": SHA or TAG,
        "prerelease": "0",
        "draft": "0",
    })
    rel_id = created.get("id")
    if not rel_id:
        raise SystemExit("Gitee Release 创建失败: %s" % json.dumps(created, ensure_ascii=False)[:500])
    print("Gitee Release %s 已创建（id=%s）。" % (TAG, rel_id))

# 3. 幂等上传 tgz 资产
rel = api_get(API + "/releases/%s" % rel_id)
assets = rel.get("assets") or []
if any((a.get("name") or "").endswith(".tgz") for a in assets):
    print("Gitee Release %s 已有 tgz 资产，跳过上传。" % TAG)
else:
    boundary = "----dshGitee" + uuid.uuid4().hex
    with open(TGZ, "rb") as fh:
        file_bytes = fh.read()
    filename = os.path.basename(TGZ)
    parts = [
        ("--%s\r\n" % boundary).encode(),
        ('Content-Disposition: form-data; name="access_token"\r\n\r\n%s\r\n' % TOKEN).encode(),
        ("--%s\r\n" % boundary).encode(),
        ('Content-Disposition: form-data; name="file"; filename="%s"\r\n' % filename).encode(),
        b"Content-Type: application/octet-stream\r\n\r\n",
        file_bytes,
        ("\r\n--%s--\r\n" % boundary).encode(),
    ]
    req = urllib.request.Request(
        API + "/releases/%s/attach_files" % rel_id,
        data=b"".join(parts), method="POST",
        headers={"Content-Type": "multipart/form-data; boundary=%s" % boundary},
    )
    with urllib.request.urlopen(req, context=CTX, timeout=180) as r:
        up = json.loads(r.read().decode("utf-8"))
    if not up.get("id"):
        raise SystemExit("Gitee 资产上传失败: %s" % json.dumps(up, ensure_ascii=False)[:500])
    print("Gitee 资产已上传（id=%s, size=%s）。" % (up.get("id"), up.get("size")))
