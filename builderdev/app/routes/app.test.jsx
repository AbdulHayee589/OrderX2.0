import { useState } from "react";
import First from "../components/Landing/First";
import { authenticate } from "../shopify.server";
import { useLoaderData } from "react-router";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const response = admin.graphql(`
  #grapghql
  query fetchProducts {
    products(first:50) {
      edges {
        node {
          id
          title
          handle
          featuredImage{
            url
            altText
          }
        }
      }
    }
  }`);

  const productsData = (await (await response).json()).data;

  return { products: productsData.products.edges };
};

export default function TestPage() {
  const [currentStep, setCurrentStep] = useState(0);
  const totalSteps = 5;
  const progress = ((currentStep / totalSteps) * 100).toFixed(2);
  const { products } = useLoaderData();

  return (
    <s-page>
      {/* Setup Process area */}
      <div style={{ padding: "1rem 0" }}>
        <h2 style={{ margin: "0 0 0.25rem 0" }}>Setup Process</h2>
        <div style={{ display: "flex", gap: "24px", alignItems: "center" }}>
          {" "}
          <div style={{ fontSize: "14px", color: "#637381", minWidth: "80px" }}>
            {currentStep}/{totalSteps} steps
          </div>
          <div
            style={{
              width: "100%",
              height: "12px",
              backgroundColor: "#e0e0e0",
              borderRadius: "6px",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${progress}%`,
                height: "100%",
                backgroundColor: "#4CAF50",
                transition: "width 0.3s ease",
              }}
            />
          </div>
        </div>
      </div>

      {currentStep === 0 && (
        <First
          products={products}
          setCurrentStep={setCurrentStep}
          currentStep={currentStep}
          totalSteps={totalSteps}
        />
      )}
    </s-page>
  );
}
