import axios from "axios";

async function makePostRequest() {
  try {
    const response = await axios.post(
      //"https://n8n.edgecenter.ru/webhook/d0f48489-1df0-47c2-a48d-b557bb5e4cda",
      "https://n8n.edgecenter.ru/webhook-test/d0f48489-1df0-47c2-a48d-b557bb5e4cda",
      {
        prompt: "This is a sample prompt for testing the webhook"
      },
      {
        headers: {
          "Content-Type": "application/json"
        }
      }
    );
    
    console.log("Response:", response.data);
  } catch (error) {
    console.error("Error making request:", error.message);
  }
}

makePostRequest();
