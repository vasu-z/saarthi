import base64
import binascii
import logging
from fastapi import APIRouter, HTTPException, status
from app.core.config import get_settings
from app.schemas.ai import (
    AIStatusResponse,
    AITestRequest,
    AITestResponse,
    AIVisionRequest,
    AIVisionResponse,
    AIQueryRequest,
    AIQueryResponse,
    DEFAULT_VISION_PROMPT,
    MAX_DECODED_IMAGE_SIZE_BYTES,
    SUPPORTED_MIME_TYPES,
)
from app.schemas.scene_analysis import (
    DetectedObject,
    DetectedText,
    SceneAnalysisRequest,
    SceneAnalysisResponse,
)
from app.services.gemini import GeminiServiceException, analyze_image, generate_text

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get(
    "/status",
    response_model=AIStatusResponse,
    summary="Check AI configuration status",
    description="Check whether a Gemini API key is configured or development mock mode is enabled without exposing keys.",
)
def get_ai_status() -> AIStatusResponse:
    """Return whether the Gemini API key is configured and which model is selected."""
    settings = get_settings()
    return AIStatusResponse(
        configured=settings.is_gemini_configured or settings.ENABLE_AI_MOCK,
        model=settings.GEMINI_MODEL,
        mock_mode=settings.ENABLE_AI_MOCK,
    )



@router.post(
    "/test",
    response_model=AITestResponse,
    summary="Test Gemini text generation",
    description="Make a real, short text-generation request to the configured Gemini model.",
)
def test_ai_connectivity(request: AITestRequest = AITestRequest()) -> AITestResponse:
    """Perform a short connectivity test against the official Gemini API."""
    settings = get_settings()

    if not settings.is_gemini_configured:
        if settings.ENABLE_AI_MOCK:
            return AITestResponse(
                status="mock_success",
                model=f"mock-{settings.GEMINI_MODEL}",
                prompt=request.prompt,
                response="[MOCK AI] SAARTHI is running in local development mode without external API keys.",
            )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Gemini API key is not configured. Please set GEMINI_API_KEY in backend/.env.",
        )

    try:
        response_text = generate_text(
            prompt=request.prompt,
            api_key=settings.GEMINI_API_KEY,
            model=settings.GEMINI_MODEL,
        )
        return AITestResponse(
            status="success",
            model=settings.GEMINI_MODEL,
            prompt=request.prompt,
            response=response_text,
        )
    except GeminiServiceException as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail=exc.message,
        )


@router.post(
    "/query",
    response_model=AIQueryResponse,
    summary="Answer natural language university or general questions",
    description="Ask a general question to the configured Gemma/Gemini model.",
)
def answer_general_query(request: AIQueryRequest) -> AIQueryResponse:
    """Answer a user question concisely for accessible voice output."""
    settings = get_settings()

    if not settings.is_gemini_configured:
        if settings.ENABLE_AI_MOCK:
            return AIQueryResponse(
                status="mock_success",
                model=f"mock-{settings.GEMINI_MODEL}",
                question=request.question,
                answer=f"[MOCK AI] You asked: '{request.question}'. The Chandigarh University assistant is ready.",
                confidence=0.85,
            )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="AI model is not configured. Please set GEMINI_API_KEY in backend/.env.",
        )

    try:
        combined_prompt = f"{request.context}\n\nUser Question: {request.question}\nAnswer:"
        response_text = generate_text(
            prompt=combined_prompt,
            api_key=settings.GEMINI_API_KEY,
            model=settings.GEMINI_MODEL,
        )
        return AIQueryResponse(
            status="success",
            model=settings.GEMINI_MODEL,
            question=request.question,
            answer=response_text.strip(),
            confidence=0.90,
        )
    except GeminiServiceException as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail=exc.message,
        )


@router.post(
    "/vision",
    response_model=AIVisionResponse,
    summary="Analyze image with Gemini Vision",
    description="Analyze a Base64-encoded image with Gemini Vision for accessible scene description.",
)
def analyze_scene_image(request: AIVisionRequest) -> AIVisionResponse:
    """
    Process an image using Gemini Vision optimized for visually impaired users.
    Validates Base64 encoding, size limits, and image headers.
    """
    settings = get_settings()

    if not settings.is_gemini_configured and not settings.ENABLE_AI_MOCK:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Gemini API key is not configured. Please set GEMINI_API_KEY in backend/.env.",
        )



    # 1. Clean Base64 payload (strip whitespace and optional data URI prefix)
    raw_b64 = request.image_base64.strip() if request.image_base64 else ""
    if not raw_b64:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Image data cannot be empty.",
        )

    if raw_b64.startswith("data:") and "," in raw_b64:
        raw_b64 = raw_b64.split(",", 1)[1].strip()

    # 2. Validate MIME type
    declared_mime = (request.mime_type or "image/jpeg").lower().strip()
    if declared_mime == "image/jpg":
        declared_mime = "image/jpeg"
    if declared_mime not in SUPPORTED_MIME_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported image MIME type '{request.mime_type}'. Supported types: image/jpeg, image/png.",
        )

    # 3. Decode Base64 data
    try:
        image_bytes = base64.b64decode(raw_b64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or malformed Base64 image data.",
        )

    # 4. Check decoded size
    if len(image_bytes) == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Decoded image data is empty.",
        )

    if len(image_bytes) > MAX_DECODED_IMAGE_SIZE_BYTES:
        max_mb = MAX_DECODED_IMAGE_SIZE_BYTES // (1024 * 1024)
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"Image size exceeds the maximum allowed limit of {max_mb} MB.",
        )

    # 5. Validate magic bytes signature for JPEG / PNG
    is_jpeg = image_bytes.startswith(b"\xff\xd8\xff")
    is_png = image_bytes.startswith(b"\x89PNG\r\n\x1a\n")
    if not (is_jpeg or is_png):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid image format. Decoded data does not match a valid JPEG or PNG signature.",
        )

    resolved_mime = "image/jpeg" if is_jpeg else "image/png"

    # 6. Compose effective prompt for blind/low-vision navigation
    user_prompt = request.prompt.strip() if request.prompt and request.prompt.strip() else None
    if user_prompt:
        effective_prompt = f"User Question: {user_prompt}\n\nPlease answer based strictly on what is visible in the image."
        prompt_used = user_prompt
    else:
        effective_prompt = DEFAULT_VISION_PROMPT
        prompt_used = DEFAULT_VISION_PROMPT

    logger.info(
        "Vision analysis requested: image_size=%d bytes, mime_type=%s, has_custom_prompt=%s",
        len(image_bytes),
        resolved_mime,
        bool(user_prompt),
    )

    # 7. Call Gemini Vision service or mock mode
    if not settings.is_gemini_configured and settings.ENABLE_AI_MOCK:
        mock_description = (
            "[MOCK AI] In front of you is a room door labeled 'Room 204 — Computer Science Dept'. "
            "Drop-offs and ground obstacles below the camera view were not checked."
        )
        return AIVisionResponse(
            status="mock_success",
            model=f"mock-{settings.GEMINI_MODEL}",
            prompt=prompt_used,
            description=mock_description,
            confidence=0.92,
            extracted_text="Room 204 — Computer Science Dept",
            uncertainties=[],
            unchecked_areas=["Drop-offs and ground obstacles below camera field of view"],
            needs_rescan=False,
        )

    try:
        description = analyze_image(
            image_bytes=image_bytes,
            mime_type=resolved_mime,
            prompt=effective_prompt,
            api_key=settings.GEMINI_API_KEY,
            model=settings.GEMINI_MODEL,
        )

        logger.info(
            "Vision analysis completed successfully: model=%s, desc_len=%d chars",
            settings.GEMINI_MODEL,
            len(description),
        )

        # Disclose safety limitations (Rule 5)
        return AIVisionResponse(
            status="success",
            model=settings.GEMINI_MODEL,
            prompt=prompt_used,
            description=description,
            confidence=0.90,
            uncertainties=[],
            unchecked_areas=["Drop-offs and ground obstacles below camera field of view"],
            needs_rescan=False,
        )
    except GeminiServiceException as exc:
        logger.warning("Vision analysis error: status_code=%d, detail=%s", exc.status_code, exc.message)
        raise HTTPException(
            status_code=exc.status_code,
            detail=exc.message,
        )


@router.post(
    "/scene-assist",
    response_model=SceneAnalysisResponse,
    summary="Live Camera Assist scene analysis",
    description="Analyze a captured camera frame with Gemma 4 vision, returning a concise spoken description, detected landmarks/objects/signs, and honest uncertainty/safety bounds.",
)
def live_scene_assist(request: SceneAnalysisRequest) -> SceneAnalysisResponse:
    """Analyze a camera frame for Live Camera Assist with safety disclosures."""
    settings = get_settings()

    if not settings.is_gemini_configured and not settings.ENABLE_AI_MOCK:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Gemini API key is not configured. Please set GEMINI_API_KEY in backend/.env.",
        )

    # 1. Clean Base64 payload
    raw_b64 = request.image_base64.strip() if request.image_base64 else ""
    if not raw_b64:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Image data cannot be empty.",
        )

    if raw_b64.startswith("data:") and "," in raw_b64:
        raw_b64 = raw_b64.split(",", 1)[1].strip()

    # 2. Validate MIME type
    declared_mime = (request.mime_type or "image/jpeg").lower().strip()
    if declared_mime == "image/jpg":
        declared_mime = "image/jpeg"
    if declared_mime not in SUPPORTED_MIME_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported image MIME type '{request.mime_type}'. Supported types: image/jpeg, image/png.",
        )

    # 3. Decode Base64 data
    try:
        image_bytes = base64.b64decode(raw_b64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or malformed Base64 image data.",
        )

    # 4. Check decoded size
    if len(image_bytes) == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Decoded image data is empty.",
        )

    if len(image_bytes) > MAX_DECODED_IMAGE_SIZE_BYTES:
        max_mb = MAX_DECODED_IMAGE_SIZE_BYTES // (1024 * 1024)
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"Image size exceeds the maximum allowed limit of {max_mb} MB.",
        )

    # 5. Validate magic bytes signature for JPEG / PNG
    is_jpeg = image_bytes.startswith(b"\xff\xd8\xff")
    is_png = image_bytes.startswith(b"\x89PNG\r\n\x1a\n")
    if not (is_jpeg or is_png):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid image format. Decoded data does not match a valid JPEG or PNG signature.",
        )

    resolved_mime = "image/jpeg" if is_jpeg else "image/png"

    # 6. Compose effective prompt for blind/low-vision live assistance
    query_text = request.query.strip() if request.query and request.query.strip() else None
    if query_text:
        effective_prompt = (
            f"User query: {query_text}\n"
            "Analyze what is directly visible in front of the camera on this campus. "
            "In 1 to 2 short, natural spoken sentences, state the primary object, door, sign, or landmark visible, "
            "and note any obvious obstacle in view. "
            "Never guess room numbers, distances, or state that the path is clear. "
            "If blurry or dark, state that the image is not clear enough to identify details."
        )
    else:
        effective_prompt = (
            "Analyze what is directly visible in front of the camera on this university campus. "
            "In 1 to 2 short, natural spoken sentences, describe the primary object, door, sign, corridor, or obstacle in view. "
            "Read any legible room numbers or signs verbatim. "
            "Do not fabricate distances or claim the path is clear. "
            "If blurry or dim, state plainly that the image is unclear."
        )

    # 7. Mock mode
    if not settings.is_gemini_configured and settings.ENABLE_AI_MOCK:
        mock_spoken = (
            "[MOCK AI] In front of you is a corridor with Room 204 on the left and stairs ahead. "
            "Drop-offs and ground obstacles below the camera view were not checked."
        )
        return SceneAnalysisResponse(
            status="mock_success",
            model=f"mock-{settings.GEMINI_MODEL}",
            spoken_description=mock_spoken,
            objects=[
                DetectedObject(label="door", relative_position="left", confidence=0.92),
                DetectedObject(label="stairs", relative_position="center", confidence=0.88),
            ],
            detected_texts=[
                DetectedText(text="Room 204", context="door", confidence=0.95),
            ],
            spatial_description="Corridor ahead with doors on the left side.",
            uncertainties=[],
            unchecked_areas=[
                "Ground-level obstacles and drop-offs below the camera field of view",
                "Areas behind the camera or outside the visible frame",
            ],
            image_quality="good",
            needs_rescan=False,
            confidence=0.90,
        )

    # 8. Call Gemma 4 / Gemini vision
    try:
        description = analyze_image(
            image_bytes=image_bytes,
            mime_type=resolved_mime,
            prompt=effective_prompt,
            api_key=settings.GEMINI_API_KEY,
            model=settings.GEMINI_MODEL,
        )

        is_unclear = any(
            kw in description.lower()
            for kw in ["blurry", "too dark", "cannot see", "unclear", "not clear", "hold steady"]
        )
        quality = "poor" if is_unclear else "good"
        needs_rescan = is_unclear

        return SceneAnalysisResponse(
            status="success",
            model=settings.GEMINI_MODEL,
            spoken_description=description,
            objects=[],
            detected_texts=[],
            spatial_description=None,
            uncertainties=["Ground obstacles or low-lying hazards below camera view"]
            if not is_unclear
            else ["Image clarity was insufficient"],
            unchecked_areas=[
                "Ground-level obstacles and drop-offs below the camera field of view",
                "Areas behind the camera or outside the visible frame",
            ],
            image_quality=quality,
            needs_rescan=needs_rescan,
            confidence=0.60 if is_unclear else 0.88,
        )
    except GeminiServiceException as exc:
        logger.warning("Scene assist error: status_code=%d, detail=%s", exc.status_code, exc.message)
        raise HTTPException(
            status_code=exc.status_code,
            detail=exc.message,
        )


