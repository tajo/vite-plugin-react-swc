import { useState } from "react";
import styled from "styled-components";

// Ensure HMR of styled component alongside other components
export const StyledCode = styled.code`
  color: palevioletred;
`;

export const Counter = () => {
  const [count, setCount] = useState(0);

  return (
    <button
      css={`
        border-radius: 3px;
        padding: 0.5rem 1rem;
        color: pink;
        background: transparent;
        border: 2px solid black;
      `}
      onClick={() => setCount(count + 1)}
    >
      count is {count}
    </button>
  );
};
