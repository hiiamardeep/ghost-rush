"""Local and hosted Uvicorn launcher; Render provides PORT at runtime."""

import os

import uvicorn

from app import app


if __name__ == "__main__":
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "3001")),
        workers=1,
    )
