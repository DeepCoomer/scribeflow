"""R2 object download for workers (boto3 S3 client). Workers only ever read
keys handed to them in queue messages, which the API minted under
tenant/{tenant_id}/… — the prefix is validated against the message's tenant
before download as defense in depth (D20)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import boto3

from .config import Settings


def create_client(settings: Settings) -> Any:
    return boto3.client(
        "s3",
        region_name="auto",
        endpoint_url=settings.r2_endpoint_url,
        aws_access_key_id=settings.r2_access_key_id,
        aws_secret_access_key=settings.r2_secret_access_key,
    )


def assert_tenant_key(r2_key: str, tenant_id: str) -> None:
    prefix = f"tenant/{tenant_id}/"
    if not r2_key.startswith(prefix):
        raise ValueError(f"r2 key {r2_key!r} is outside tenant prefix {prefix!r}")


def download(client: Any, bucket: str, r2_key: str, dest_dir: Path) -> Path:
    dest = dest_dir / Path(r2_key).name
    client.download_file(bucket, r2_key, str(dest))
    return dest


def upload(client: Any, bucket: str, r2_key: str, local_path: Path) -> None:
    client.upload_file(str(local_path), bucket, r2_key)


def chunk_key(tenant_id: str, meeting_id: str, chunk_idx: int) -> str:
    return f"tenant/{tenant_id}/meeting/{meeting_id}/chunks/{chunk_idx}.flac"
