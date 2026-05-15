from vieneu import Vieneu

tts = Vieneu(emotion="storytelling")
voice = tts.get_preset_voice("Ngọc")

text = (
    "Tóm lại, những ý kiến trong bài viết này cho rằng, "
    "sự phân hóa chính trị cực đoan trên mạng xã hội "
    "là biểu hiện của di chứng chiến tranh chưa thực sự được hàn gắn."
)

audio = tts.infer(text=text, voice=voice)
tts.save(audio, "output.wav")
print(f"Saved output.wav ({len(audio) / tts.sample_rate:.1f}s)")
