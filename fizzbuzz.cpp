#include <iostream>
#include <cassert>
#include <sstream>

std::string getFizzBuzz(int n) {
    if (n % 3 == 0 && n % 5 == 0) return "FizzBuzz";
    if (n % 3 == 0) return "Fizz";
    if (n % 5 == 0) return "Buzz";
    return std::to_string(n);
}

void runTests() {
    assert(getFizzBuzz(1) == "1");
    assert(getFizzBuzz(2) == "2");
    assert(getFizzBuzz(3) == "Fizz");
    assert(getFizzBuzz(5) == "Buzz");
    assert(getFizzBuzz(6) == "Fizz");
    assert(getFizzBuzz(10) == "Buzz");
    assert(getFizzBuzz(15) == "FizzBuzz");
    assert(getFizzBuzz(30) == "FizzBuzz");
    std::cout << "All tests passed successfully!" << std::endl;
}

int main() {
    runTests();
    
    std::cout << "\n--- FizzBuzz 1 to 20 ---" << std::endl;
    for (int i = 1; i <= 20; ++i) {
        std::cout << getFizzBuzz(i) << std::endl;
    }
    return 0;
}