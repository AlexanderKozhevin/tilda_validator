import axios from "axios";

async function testOllama() {
  try {
    console.log("Testing Ollama connection...");
    
    const { data } = await axios.post(
      "http://10.92.75.207:11434/api/generate",
      {
        model: "gpt-oss:120b",
        stream: false,
        "think": "high",
        prompt: "Hello world! Please respond with a friendly greeting."
      },
      { headers: { "Content-Type": "application/json" } }
    );
    
    console.log("Ollama response:", data?.response?.trim());
  } catch (error) {
    console.error("Error testing Ollama:", error.message);
  }
}

testOllama();
