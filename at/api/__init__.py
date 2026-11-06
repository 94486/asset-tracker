# -*- coding: utf-8 -*-
"""API 蓝图集合：每个模块一个 Blueprint，统一挂到 /api 前缀下"""
from .data_io import data_io_bp
from .products import products_bp
from .reports import reports_bp
from .wishlist import wishlist_bp

BLUEPRINTS = (products_bp, wishlist_bp, reports_bp, data_io_bp)

__all__ = ["BLUEPRINTS", "products_bp", "wishlist_bp", "reports_bp", "data_io_bp"]
