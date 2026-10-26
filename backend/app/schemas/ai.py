from typing import Optional
from pydantic import BaseModel, Field

DEFAULT_VISION_PROMPT = (
    "Describe what is visibly in front of the camera in 1 to 3 natural spoken sentences. "
    "Prioritize the main object directly in view, its appearance, nearby items, and any immediate obstacles. "
    "Read any legible text, labels, or signs. State clearly what is certain versus uncertain, and do not invent details without clear visual evidence."
)

SUPPORTED_MIME_TYPES = {"image/jpeg", "image/png", "image/jpg"}
MAX_DECODED_IMAGE_SIZE_BYTES = 8 * 1024 * 1024  # 8 MB


class AIStatusResponse(BaseModel):
    """Schema for reporting AI configuration status without exposing credentials."""

    configured: bool
    model: str
    mock_mode: bool = False



class AITestRequest(BaseModel):
    """Schema for triggering a minimal Gemini text generation test."""

    prompt: str = Field(
        default="Say hello in 5 words or less.",
        description="Text prompt to send to Gemini for connectivity verification.",
        max_length=500,
    )


class AITestResponse(BaseModel):
    """Schema for Gemini text generation test response."""

    status: str
    model: str
    prompt: str
    response: str


class AIVisionRequest(BaseModel):
    """Schema for multimodal image analysis request."""

    image_base64: str = Field(
        ...,
        description="Base64-encoded JPEG or PNG image data (with or without data URI prefix).",
    )
    prompt: Optional[str] = Field(
        default=None,
        description="Optional custom query. If omitted, uses default accessible guidance prompt.",
        max_length=2000,
    )
    mime_type: Optional[str] = Field(
        default="image/jpeg",
        description="MIME type of the image. Must be image/jpeg or image/png.",
    )


class AIVisionResponse(BaseModel):
    """Schema for multimodal image analysis response (excludes raw image data)."""

    status: str
    model: str
    prompt: str
    description: str
    confidence: float = Field(
        default=0.92,
        ge=0.0,
        le=1.0,
        description="Confidence score between 0.0 and 1.0. Values below 0.65 require a re-scan.",
    )
    uncertainties: list[str] = Field(
        default_factory=list,
        description="Specific items, text, or obstacles that could not be determined with high certainty.",
    )
    unchecked_areas: list[str] = Field(
        default_factory=lambda: ["Drop-offs and ground obstacles below camera field of view"],
        description="Explicit regions not verified (Rule 5: never claim path is clear).",
    )
    needs_rescan: bool = Field(
        default=False,
        description="True if image clarity, confidence, or blur prevented safe description.",
    )
    extracted_text: Optional[str] = Field(
        default=None,
        description="Verbatim text extracted from signs, notices, or plaques without speculation.",
    )


class AIQueryRequest(BaseModel):
    """Schema for natural-language campus or general queries."""

    question: str = Field(..., min_length=1, max_length=1000, description="User's spoken or typed question")
    context: Optional[str] = Field(
        default="You are Saarthi, an accessible voice assistant for Chandigarh University students. Provide concise, helpful 1 to 2 sentence answers.",
        description="System prompt instruction or context for the answer",
    )


class AIQueryResponse(BaseModel):
    """Schema for AI query response."""

    status: str
    model: str
    question: str
    answer: str
    confidence: float = 0.90

