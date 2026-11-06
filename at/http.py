# -*- coding: utf-8 -*-
"""请求辅助：把 JSON body 统一收敛成 dict

前端始终发对象，但直接调 API 时可能传数组/字符串/null。
统一在这里兜住，避免 `p.get` 在非 dict 上抛 AttributeError 变成 500。
"""
from flask import request


def json_body():
    p = request.get_json(silent=True)
    return p if isinstance(p, dict) else {}
